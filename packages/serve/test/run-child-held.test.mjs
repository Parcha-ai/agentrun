// What a run's own process (run-child.ts) is answered by its runner (run-child-host.ts): each answer bound on the runner
// to the claim it holds, whatever the process names. A GitHub token of the run's own pull request's repository alone,
// contents read; decision and tier keys of the claim's learned workflows alone, as the runner chose them; the saved model
// keys of its subagent tiers' models alone, never another provider's, and a replay's grader on the runner its fast
// tier's model's key alone; the settings of
// the server's shared configuration and the claim's own rows, never another run's; its viewers' address under its own
// run's proof key, never the runners' shared one; no channel post; the computer it made let go by the runner at the
// claim's release; the install it asks for, readable by its user. Which runs stay in the runner; where runs have users of
// their own, a run on AgentRun's own Claude Code login folder claimed as a process of its own, one on the machine's own
// login, or beside a runner whose login runs stay in its process, refused at its claim. And the channel lets go of a function it handed once the other side's
// stand-in for it is gone. No key, no network: a fake GitHub on loopback, dummy keys.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { seal } from "../dist/sealing.js";
import { storeOn } from "./store-helpers.mjs";
import { stranger } from "./fixtures/stranger.mjs";
import { landWorkflows, promoteChecked, startAt } from "./learned-workflow-seed-support.mjs";

// Namespaces: a name the runner does not export reads as undefined, and its assertion says what is missing.
const host = await import("../dist/runner/run-child-host.js");
const live = await import("../dist/live-reach.js");
const { sealRunLaunch } = await import("../dist/store/index.js");
const { Channel } = await import("../dist/runner/run-channel.js");
const { withSavedGateway } = await import("../dist/model-gateway.js");
const spec = await import("../dist/runner/adapter-run-spec.js");
const { routedSubagentTiers } = await import("../dist/runner/subagent.js");
const { MODEL_KEY_NAMES, subagentTierKeys } = await import("../dist/runner/claim-secrets.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { FAUX_ENV, FAUX_PROVIDER } = await import("../dist/model.js");
const { loginForRun, settingFor } = await import("../dist/claude-login.js");

const KEY = randomBytes(32);
const { privateKey: PEM } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
// Dummy key values, built so the source scan reads no literal credential.
const PARALLEL_DUMMY = `not-a-secret-${"parallel-key"}`;
const ANTHROPIC_DUMMY = `not-a-secret-${"anthropic-key"}`;
const OPENAI_DUMMY = `not-a-secret-${"openai-key"}`;
const XAI_DUMMY = `not-a-secret-${"xai-key"}`;
const GATEWAY_DUMMY = `not-a-secret-${"gateway-key"}`;
const HEAD = "a".repeat(40);
const PULL = `Review it.\n\n<trigger-payload source="github" installation="777" repo="acme/widgets" number="7" head_sha="${HEAD}">{}</trigger-payload>`;

/** Every folder under `dir` its owner's to write again, so the test's own cleanup removes it. */
function chmodTree(dir) {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) chmodTree(join(dir, name));
}

/** The GitHub App's rows, sealed under KEY as the server's sealed settings write them. */
async function connected(store) {
  for (const [field, value] of [["app_id", "4242"], ["private_key", PEM], ["slug", "agentrun-test-app"]]) {
    await store.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(KEY, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  }
}

/** A fake GitHub that makes installation 777's tokens; every request it is asked, kept. */
async function fakeGitHub(t) {
  const asked = [];
  const server = createServer((req, res) => {
    if (stranger(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      asked.push({ method: req.method, url: req.url, body });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) return answer(201, { token: "not-a-secret-ghs-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      return answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}`, asked };
}

/** The runner's answers for claim run-own (agent-own, rev-own) of `revision` and `launch`, over `store`; `login` the
 *  login its claim read (staysInRunner), `cut` the runner's redactor for the run. */
function heldOf(store, { env = {}, githubApi, data = "/nonexistent-data", revision = { kind: "agentic", body: {} }, launch = { input: { content: "Hello." } }, login, cut = (text) => text } = {}, lines = []) {
  const deps = { store, sealKey: KEY, env, data, ...(githubApi ? { githubApi } : {}) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision, claimed: {}, ...(login ? { login } : {}) };
  return host.heldFor(deps, reads, cut, (line) => void lines.push(line)).held;
}

/** A held run's deferred refusal: its model kept from running (run-launch.ts hold.refused), every word fake. */
const REFUSAL = {
  message: "No OpenRouter key here for openrouter/anthropic/claude-sonnet-5.5: add one in Settings → Model keys, or set OPENROUTER_API_KEY where AgentRun starts.",
  fields: [{ field: "definition.model", reason: "not_runnable", message: "No OpenRouter key here for openrouter/anthropic/claude-sonnet-5.5." }],
  details: { unbound: [], missing: {} },
};

/** Each run that sends no model key (claim-secrets.ts sendsNoModelKey), as the runner's env and the launch's own fields:
 *  any run on a --faux runner, a faux-pinned launch claimed on a runner off faux, and a held run its model kept from running. */
const SENDS_NO_MODEL_KEY = [
  ["on a --faux runner", { [FAUX_ENV]: "1" }, {}],
  ["faux-pinned on a runner off faux", {}, { model: { provider: FAUX_PROVIDER, modelId: "faux-1" } }],
  ["held, its model kept from running", {}, { hold: { minutes: 5, refused: REFUSAL } }],
];

test("a run's process mints a GitHub token for its own pull request's repository alone, contents read, whatever repository or permissions it names; a run with no pull-request checkout gets no access", async (t) => {
  const { store } = await storeOn(t);
  await connected(store);
  const github = await fakeGitHub(t);
  const lines = [];
  const launch = { input: { content: PULL }, inputOrigin: { kind: "trigger", source: "github" } };
  const held = heldOf(store, { githubApi: github.api, revision: { kind: "agentic", body: { checkout: "pull_request" } }, launch }, lines);
  const access = await held.githubAppAccess();
  assert.deepEqual(access.target, { repo: "acme/widgets", installation: 777 });
  await assert.rejects(access.mint({ repo: "acme/other", installation: 777 }), /only for its own pull request's repository/);
  await assert.rejects(access.mint({ repo: "acme/widgets", installation: 778 }), /only for its own pull request's repository/);
  await assert.rejects(access.mint(undefined), /only for its own pull request's repository/);
  assert.deepEqual(github.asked, [], "a refused mint asked GitHub nothing");
  assert.ok(lines.some((line) => /asked for a GitHub token of another repository/.test(line)), lines.join("\n"));
  // Asked with no permissions, or with the App's write ones: contents read, of the one repository.
  for (const permissions of [undefined, { contents: "write", pull_requests: "write" }]) {
    const minted = await access.mint({ repo: "acme/widgets", installation: 777 }, permissions);
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.deepEqual(JSON.parse(github.asked.at(-1).body), { repositories: ["widgets"], permissions: { contents: "read" } }, JSON.stringify(permissions));
  }
  // The same launch on a revision that checks out no pull request: nothing to mint for.
  assert.equal(await heldOf(store, { githubApi: github.api, launch }).githubAppAccess(), undefined);
});

test("a GitHub token minted for a run's process joins its runner's redactor, so nothing the runner writes of the run shows it", async (t) => {
  const { keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  await connected(store);
  const github = await fakeGitHub(t);
  const cut = heldRedactor(keepText);
  const launch = { input: { content: PULL }, inputOrigin: { kind: "trigger", source: "github" } };
  const access = await heldOf(store, { githubApi: github.api, revision: { kind: "agentic", body: { checkout: "pull_request" } }, launch, cut }).githubAppAccess();
  assert.equal(cut("the token is not-a-secret-ghs-token"), "the token is not-a-secret-ghs-token", "nothing minted yet, nothing held");
  const minted = await access.mint({ repo: "acme/widgets", installation: 777 });
  assert.equal(minted.ok, true, JSON.stringify(minted));
  assert.ok(!cut(`the token is ${minted.token}`).includes(minted.token), "the minted token is cut from what the runner writes");
});

const judgeFlow = (name, provider) => ({
  v: 2, name,
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Coi", path: "coi" },
  root: { node: "chain", steps: [{ node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi", provider }] },
});

/** A learned workflow of one model node on the strong tier. */
const strongFlow = {
  v: 2, name: "on-strong",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tier: "strong" }] },
};

test("a run that sends no model key (a --faux runner's, a faux-pinned one, a held one) is answered no tier's model key, for a subagent tier or a learned workflow's; off faux, unpinned and not held, each its tier's key", async (t) => {
  const { store } = await storeOn(t);
  // OpenAI's and Anthropic's keys saved; the subagent's fast tier is the revision's OpenAI model, the learned workflow's
  // strong tier the host's Anthropic one.
  await putSealedKey(store, KEY, "OPENAI_API_KEY", OPENAI_DUMMY);
  await putSealedKey(store, KEY, "ANTHROPIC_API_KEY", ANTHROPIC_DUMMY);
  const host = { AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5" };
  const subagent = { kind: "agentic", body: { tools: ["subagent"], modelTiers: { fast: "openai/gpt-6.1-sol" } } };
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-child-held-faux-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const sha = await landWorkflows(store, "agent-own", [{ name: "on-strong", description: "Answers a question", workflow: strongFlow }]);
  await promoteChecked(store, "agent-own", [{ name: "on-strong", workflow: strongFlow }]);
  const learning = { input: { content: "Hello." }, learning: startAt(sha) };
  for (const [where, env, own] of [["off faux, unpinned and not held", {}, {}], ...SENDS_NO_MODEL_KEY]) {
    // The subagent's run on a host that names no tier: its fast tier alone routes a model.
    const tiers = await heldOf(store, { env, revision: subagent, launch: { input: { content: "Hello." }, ...own } }).subagentTierKeys();
    const learner = heldOf(store, { env: { ...host, ...env }, data, launch: { ...learning, ...own } });
    if (own.hold) {
      // A held run never reaches a learned tier: learnedFirst refuses it (no audit, no replay, no workflow), so the runner
      // chose no workflow whose tier it could ask. What holds for it is its subagent tiers' answer, asserted below.
      await assert.rejects(learner.learnedFirst({ laid: true }), `${where}: the runner chose no workflow for it`);
      assert.deepEqual(Object.keys(tiers).filter((name) => MODEL_KEY_NAMES.includes(name)), [], `${where}: granted subagent, it is answered a model key, which it never sends`);
      assert.deepEqual(tiers, {}, `${where}: no key at all for its subagent tiers`);
      continue;
    }
    assert.deepEqual((await learner.learnedFirst({ laid: true })).workflows.map(({ name }) => name), ["on-strong"], `${where}: the runner chose the claim's workflow`);
    const learned = (await learner.tierModelKeys(["strong"])).keys;
    if (!env[FAUX_ENV] && !own.model) {
      assert.deepEqual(tiers, { OPENAI_API_KEY: OPENAI_DUMMY }, `${where}, a run granted subagent: its fast tier's model's key alone`);
      assert.deepEqual(learned, { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY }, `${where}, a learned workflow's strong tier: its model's key alone`);
    } else {
      assert.deepEqual(Object.keys(tiers).filter((name) => MODEL_KEY_NAMES.includes(name)), [], `${where}: granted subagent, it is answered a model key, which the faux model never sends`);
      assert.deepEqual(Object.keys(learned).filter((name) => MODEL_KEY_NAMES.includes(name)), [], `${where}: it is answered a learned workflow tier's model key, which the faux model never sends`);
      assert.deepEqual([tiers, learned], [{}, {}], `${where}: no key at all for its tiers`);
    }
  }
});

test("a run's process gets no decision or tier key its claim's learned workflows do not name: none before the runner chose them, and of those only the named", async (t) => {
  const { store } = await storeOn(t);
  const env = { AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY };
  // A run with no learned workflow, asking for Parallel's key and the strong tier's.
  const plain = heldOf(store, { env });
  assert.deepEqual(await plain.decisionKeys(["parallel"]), {}, "a run with no learned workflow naming parallel");
  assert.deepEqual((await plain.tierModelKeys(["strong"])).keys, {}, "a run with no learned workflow naming the strong tier");
  // A run whose seed lays a checked workflow asking Parallel: its key once the runner chose it, and no other provider's.
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-child-held-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const flow = judgeFlow("on-parallel", "parallel");
  const sha = await landWorkflows(store, "agent-own", [{ name: "on-parallel", description: "Checks a certificate", workflow: flow }]);
  await promoteChecked(store, "agent-own", [{ name: "on-parallel", workflow: flow }]);
  const learning = heldOf(store, { env, data, launch: { input: { content: "Hello." }, learning: startAt(sha) } });
  assert.deepEqual(await learning.decisionKeys(["parallel"]), {}, "none before the runner chose the claim's workflows");
  const first = await learning.learnedFirst({ laid: true });
  assert.deepEqual(first.workflows.map(({ name }) => name), ["on-parallel"]);
  assert.deepEqual(await learning.decisionKeys(["parallel", "jev"]), { PARALLEL_API_KEY: PARALLEL_DUMMY });
  assert.deepEqual((await learning.tierModelKeys(["strong"])).keys, {}, "its workflow names no strong tier");
});

/** The saved model keys the runner hands a run's process for its subagent tiers' routes (held.ts subagentTierKeys). */
async function tierKeysHanded(held) {
  assert.equal(typeof held.subagentTierKeys, "function", "the runner answers a run's process its subagent tiers' keys by that name (subagentTierKeys)");
  return held.subagentTierKeys();
}

/** A revision granted the subagent tool, with `modelTiers` its models of the subagent tiers. */
const subagentRevision = (modelTiers) => ({ kind: "agentic", body: { tools: ["subagent"], ...(modelTiers ? { modelTiers } : {}) } });
/** A host whose own model is OpenAI's and whose strong tier is Anthropic's, holding a key of xAI too, which no model of
 *  its names; no fast tier of its own. */
const TIERED = { AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, XAI_API_KEY: XAI_DUMMY };

test("a subagent run's process is handed the saved model keys of its tiers' models alone: never a provider's no tier of it reaches, none for a tier it routes no model on, the gateway's alone behind a gateway, none to a run with its own model key", async (t) => {
  const { store } = await storeOn(t);
  // Its strong tier runs on the host's AGENT_MODEL_STRONG: Anthropic's key. Its fast tier is named nowhere (no
  // AGENT_MODEL_FAST, no modelTiers.fast), so the run routes no model on it: no key for it. OpenAI's (the run's own model,
  // its claim's to hand) and xAI's are no tier's.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, revision: subagentRevision() })), { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY }, "the host's strong tier alone");
  // The revision's own model of a tier over the host's: xAI's key for its fast tier, Anthropic's for its strong one.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, revision: subagentRevision({ fast: "xai/grok-5" }) })), { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, XAI_API_KEY: XAI_DUMMY }, "the revision's fast tier and the host's strong tier");
  // Behind a gateway every model is the gateway's: its key alone.
  const gateway = { ...TIERED, AGENT_MODEL_BASE_URL: "https://gateway.invalid/v1", AGENT_MODEL_API_KEY: GATEWAY_DUMMY };
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: gateway, revision: subagentRevision({ fast: "xai/grok-5" }) })), { AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, "the gateway's key alone");
  // Behind the gateway saved in the console, laid over the claim's environment as the runner lays it (the environment
  // heldFor reads, and the one the run's process starts with): a tier whose model only the saved gateway names is routed,
  // so its key is handed; with no tier model saved, and none in the environment, no tier is routed and nothing is.
  const plainHost = { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, XAI_API_KEY: XAI_DUMMY };
  const saved = (models) => withSavedGateway(plainHost, { v: 1, base_url: "https://gateway.invalid/v1", ids: "as_named", models, key: GATEWAY_DUMMY });
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: saved({ fast: "gw-fast-1" }), revision: subagentRevision() })), { AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, "the saved gateway's fast tier");
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: saved({ default: "gw-1" }), revision: subagentRevision() })), {}, "a saved gateway that names no subagent tier");
  // A run that holds a model key of its own (model_key, sealed on its launch as the server seals it) gets none of the
  // server's, whatever its tiers.
  const sealed = sealRunLaunch(KEY, "run-own", { model: { key: `not-a-secret-${"run-own-key"}`, origin: "https://gateway.invalid" } });
  const keyedStore = { ...store, runs: { ...store.runs, launch: async (id) => ({ body: "{}", sealed: id === "run-own" ? sealed : null }) } };
  assert.deepEqual(await tierKeysHanded(heldOf(keyedStore, { env: TIERED, revision: subagentRevision({ fast: "xai/grok-5" }) })), {}, "a run with its own key");
});

test("a run's process with no subagent tiers gets no saved model key: a run with no subagent tool, a workflow revision that names the tool, a learning run and an SDK run (which stay in their runner and never ask); a subagent run beside them gets its tier's", async (t) => {
  const { store } = await storeOn(t);
  const hello = { input: { content: "Hello." } };
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED })), {}, "no subagent tool");
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, revision: { kind: "workflow", body: { tools: ["subagent"] } } })), {}, "a workflow revision routes no subagent tier");
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, launch: { ...hello, harness: "learning" } })), {}, "a learning run");
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, launch: { ...hello, sdk: { runtime: "claude-agent-sdk", instructions: "Policy." } } })), {}, "an SDK run");
  // The firing case on the same host: a subagent run still gets its strong tier's key.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: TIERED, revision: subagentRevision() })), { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY }, "a subagent run");
});

test("the runner's handed keys, the run's subagent tier routes and a replay's grader read one set of subagent tiers: each tier routedSubagentTiers names, on the keys of those tiers' models alone, and no other", async (t) => {
  // The one answer, and the routes made from it, by name: a runner without them fails here in these words.
  assert.equal(typeof routedSubagentTiers, "function", "one answer names the subagent tiers a run routes (subagent.ts routedSubagentTiers)");
  assert.equal(typeof spec.subagentTierRoutes, "function", "the run's subagent tier routes are made from that answer (adapter-run-spec.ts subagentTierRoutes)");
  const { store } = await storeOn(t);
  // The keys saved in Settings, sealed as the server seals them, and none in the runner's environment: so a route holds a
  // key only when it is read for it.
  for (const [name, value] of [["OPENAI_API_KEY", OPENAI_DUMMY], ["ANTHROPIC_API_KEY", ANTHROPIC_DUMMY], ["XAI_API_KEY", XAI_DUMMY]]) await putSealedKey(store, KEY, name, value);
  const own = { AGENT_MODEL: "openai/gpt-6.1-sol" };
  const cases = [
    { words: "the host's strong tier alone", env: { ...own, AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5" }, revision: subagentRevision(), tiers: ["strong"], keys: ["ANTHROPIC_API_KEY"] },
    { words: "the revision's fast tier and the host's strong tier", env: { ...own, AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5" }, revision: subagentRevision({ fast: "xai/grok-5" }), tiers: ["fast", "strong"], keys: ["ANTHROPIC_API_KEY", "XAI_API_KEY"] },
    { words: "the host's fast tier alone", env: { ...own, AGENT_MODEL_FAST: "xai/grok-5" }, revision: subagentRevision(), tiers: ["fast"], keys: ["XAI_API_KEY"] },
    { words: "no tier", env: own, revision: subagentRevision(), tiers: [], keys: [] },
  ];
  const dummies = { OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, XAI_API_KEY: XAI_DUMMY };
  for (const { words, env, revision, tiers, keys } of cases) {
    assert.deepEqual(routedSubagentTiers(revision.body, env).tiers, tiers, `${words}: the tiers routed`);
    // The runner hands a run's process those tiers' keys.
    assert.deepEqual(await tierKeysHanded(heldOf(store, { env, revision })), Object.fromEntries(keys.map((name) => [name, dummies[name]])), `${words}: the runner hands those tiers' keys`);
    // The run routes those tiers (here on the runner, as a run with no process of its own routes them), each route on the
    // keys of those tiers' models alone.
    const asked = [];
    const routeOf = async (ref, routeEnv, tier) => (asked.push({ tier, ref, keys: MODEL_KEY_NAMES.filter((name) => routeEnv[name]).sort() }), { model: { id: ref ?? `host-${tier}` } });
    const routed = await spec.subagentTierRoutes(revision.body, false, undefined, {}, heldRedactor((text) => text), { store, sealKey: KEY, env, routeOf });
    assert.deepEqual([...routed.routes.keys()], tiers.map((tier) => `subagent-${tier}`), `${words}: the run routes those tiers`);
    assert.deepEqual(asked.map(({ tier, ref }) => [tier, ref]), tiers.map((tier) => [tier, revision.body.modelTiers?.[tier]]), `${words}: each tier on its model`);
    for (const route of asked) assert.deepEqual(route.keys, keys, `${words}: the routes read those tiers' keys alone`);
    // A replay's grader routes the fast tier when it is one of them, and no route when it is not.
    let graded = 0;
    await spec.graderRouteOf(revision.body, false, undefined, {}, heldRedactor((text) => text), () => {}, { store, sealKey: KEY, env, routeOf: async () => (graded++, { model: { id: "grader" } }) });
    assert.equal(graded, tiers.includes("fast") ? 1 : 0, `${words}: the grader routes the fast tier only when it is routed`);
  }
});

/** The model keys `env` holds, by name (a route's env lays them unenumerable), with their values. */
const modelKeysIn = (env) => Object.fromEntries(MODEL_KEY_NAMES.filter((name) => env[name]).map((name) => [name, env[name]]));
/** OpenAI's, Anthropic's and xAI's keys saved in Settings, sealed as the server seals them; none in the runner's env. */
async function savedThree(store) {
  for (const [name, value] of [["OPENAI_API_KEY", OPENAI_DUMMY], ["ANTHROPIC_API_KEY", ANTHROPIC_DUMMY], ["XAI_API_KEY", XAI_DUMMY]]) await putSealedKey(store, KEY, name, value);
}
/** A host whose own model is OpenAI's and whose fast tier is xAI's. */
const FAST_ON_XAI = { AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_FAST: "xai/grok-5" };

test("a replay's grader on the runner reads the saved key of its fast tier's model alone, never every saved key: with OpenAI's, Anthropic's and xAI's keys saved, the host's fast tier on xAI is graded on xAI's", async (t) => {
  const { store } = await storeOn(t);
  await savedThree(store);
  const cases = [
    { words: "the host's fast tier, its revision naming no tier model", body: {}, keys: { XAI_API_KEY: XAI_DUMMY } },
    { words: "its revision's fast tier over the host's", body: { modelTiers: { fast: "anthropic/claude-sonnet-5-5" } }, keys: { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY } },
    // A strong tier beside the fast one: the grader routes the fast tier alone, so the strong tier's key stays unread.
    { words: "the host's fast tier, with a strong tier on Anthropic beside it", body: {}, env: { ...FAST_ON_XAI, AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5" }, keys: { XAI_API_KEY: XAI_DUMMY } },
  ];
  for (const { words, body, env = FAST_ON_XAI, keys } of cases) {
    // As a replay that stays in the runner makes it (adapter-run-spec.ts, launch.replay): the runner's seal key, a run
    // with no key of its own, its claim opening none here.
    const routed = [];
    const routeOf = async (ref, routeEnv, tier) => (routed.push({ tier, ref, keys: modelKeysIn(routeEnv) }), { model: { id: "grader" } });
    const route = await spec.graderRouteOf(body, false, undefined, {}, heldRedactor((text) => text), () => {}, { store, sealKey: KEY, env, routeOf });
    assert.ok(route, `${words}: a grader route`);
    assert.deepEqual(routed, [{ tier: "fast", ref: body.modelTiers?.fast, keys }], `${words}: the grader's route holds its fast tier's model's key alone`);
  }
});

test("a grader with no fast tier reads no saved key and routes nothing, nor does a run with its own key read one; beside them, a fast tier's grader reads its model's key", async (t) => {
  const { store } = await storeOn(t);
  await savedThree(store);
  const reads = [];
  const counted = { ...store, sealedKeys: { get: (name) => (reads.push(name), store.sealedKeys.get(name)) } };
  const graderOf = (env, keyed) => spec.graderRouteOf({}, keyed, undefined, {}, heldRedactor((text) => text), () => {}, { store: counted, sealKey: KEY, env, routeOf: async () => ({ model: { id: "grader" } }) });
  // A host with a strong tier and no fast one: nothing to grade on, so nothing read.
  assert.equal(await graderOf({ AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5" }, false), undefined, "no fast tier: no grader route");
  assert.deepEqual(reads, [], "no fast tier: no saved key read");
  assert.ok(await graderOf(FAST_ON_XAI, true), "a run with its own key: a grader route");
  assert.deepEqual(reads, [], "a run with its own key: no saved key read");
  // The firing case: the same store read for the fast tier's model.
  assert.ok(await graderOf(FAST_ON_XAI, false), "a fast tier: a grader route");
  assert.ok(reads.includes("XAI_API_KEY"), `a fast tier: its model's key read (${reads.join(", ")})`);
});

test("a runner with no seal key gives its subagent tiers the keys of their models alone from its environment, never every model key it holds", async () => {
  // No seal key and no run's process: the keys are the runner's environment's (TIERED holds OpenAI's, Anthropic's, xAI's).
  const deps = { store: undefined, sealKey: undefined, env: TIERED };
  assert.deepEqual(await subagentTierKeys(deps, ["strong"], {}), { ANTHROPIC_API_KEY: ANTHROPIC_DUMMY }, "a runner with no seal key: the host's strong tier's key alone");
  assert.deepEqual(await subagentTierKeys(deps, ["fast"], { fast: "xai/grok-5" }), { XAI_API_KEY: XAI_DUMMY }, "a runner with no seal key: the revision's fast tier's key alone");
  assert.deepEqual(await subagentTierKeys(deps, [], {}), {}, "a runner with no seal key: no tier, no key");
});

test("in a run's own process, with no seal key, the subagent tiers' keys are its runner's answer (held subagentTierKeys) and nothing read from its environment; no tier asks nothing", async (t) => {
  const { setHeld } = await import("../dist/runner/held.js");
  const asked = [];
  // Its learned tiers' seam beside it answers nothing: the subagent tiers must ask their own.
  setHeld({ subagentTierKeys: async () => (asked.push("subagentTierKeys"), { XAI_API_KEY: XAI_DUMMY }), tierModelKeys: async () => (asked.push("tierModelKeys"), { keys: {} }) });
  t.after(() => setHeld(undefined));
  // The process's environment holds other model keys (TIERED): none of them is read here.
  const deps = { store: undefined, sealKey: undefined, env: TIERED };
  assert.deepEqual(await subagentTierKeys(deps, ["fast"], {}), { XAI_API_KEY: XAI_DUMMY }, "a run's process: its runner's answer alone");
  assert.deepEqual(asked, ["subagentTierKeys"], "a run's process: its runner asked once");
  assert.deepEqual(await subagentTierKeys(deps, [], {}), {}, "a run's process: no tier, nothing asked");
  assert.deepEqual(asked, ["subagentTierKeys"], "a run's process: no tier, its runner not asked again");
});

test("a replay's or audit's process is handed the saved key of its grader's provider alone: an Anthropic agent's OpenAI fast tier, with Anthropic's, OpenAI's and Mistral's keys saved, gets OpenAI's and grades on it; a gateway route its key alone; no fast tier, a run that is neither, or a replay that brings its own key, none", async (t) => {
  const { store } = await storeOn(t);
  const { setHeld } = await import("../dist/runner/held.js");
  const { graderRouteOf } = await import("../dist/runner/adapter-run-spec.js");
  const { routeOf } = await import("../dist/runner/model-route.js");
  const { launchBody } = await import("../dist/run-launch.js");
  const MISTRAL_DUMMY = `not-a-secret-${"mistral-key"}`;
  const GATEWAY_DUMMY = `not-a-secret-${"gateway-key"}`;
  for (const [name, value] of [["OPENAI_API_KEY", OPENAI_DUMMY], ["ANTHROPIC_API_KEY", ANTHROPIC_DUMMY], ["MISTRAL_API_KEY", MISTRAL_DUMMY], ["AGENT_MODEL_API_KEY", GATEWAY_DUMMY]]) await putSealedKey(store, KEY, name, value);
  // The runner's environment: the agent's model Anthropic's, the fast tier OpenAI's, every key saved alone.
  const env = { AGENT_MODEL: "anthropic/claude-sonnet-5-5", AGENT_MODEL_FAST: "openai/gpt-6-luna" };
  const replay = { of: "run-asked", workflow: "answer", digest: "d".repeat(16) };
  const ask = { input: { content: "Hello." } };
  // The grader's route as the run's own process makes it: no seal key, its env the claim's keys (its agent's model's,
  // no OpenAI key), its fast tier's saved key asked of its runner (held.subagentTierKeys).
  const cut = heldRedactor((text) => text);
  const graded = async (held, lines) => {
    setHeld(held);
    try {
      return await graderRouteOf({}, false, undefined, {}, cut, (line) => void lines.push(line), { store: undefined, sealKey: undefined, env: { ...env, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY }, routeOf }, [cut]);
    } finally {
      setHeld(undefined);
    }
  };
  for (const [what, launch] of [["a replay", { ...ask, replay }], ["an audit", { ...ask, audit: replay }]]) {
    const held = heldOf(store, { env, launch });
    assert.deepEqual(await tierKeysHanded(held), { OPENAI_API_KEY: OPENAI_DUMMY }, `${what}: its fast tier's provider's saved key, and no other`);
    const lines = [];
    const route = await graded(held, lines);
    assert.ok(route, `${what}: a grader route (${lines.join("; ")})`);
    assert.deepEqual([route.provider.origin, route.model, await route.provider.credential()], ["https://api.openai.com", "gpt-6-luna", OPENAI_DUMMY], what);
    assert.deepEqual(lines, [], what);
  }
  // The revision's own fast tier first, as the grader's route takes it.
  const tiered = { kind: "agentic", body: { modelTiers: { fast: "mistral/mistral-large-latest" } } };
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env, revision: tiered, launch: { ...ask, audit: replay } })), { MISTRAL_API_KEY: MISTRAL_DUMMY }, "the revision's fast tier's provider");
  // Through a gateway, where every model is the gateway's: its key alone.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: { ...env, AGENT_MODEL_BASE_URL: "https://gateway.invalid/v1" }, launch: { ...ask, replay } })), { AGENT_MODEL_API_KEY: GATEWAY_DUMMY }, "a gateway route");
  // A strong tier beside the fast one: the grade routes the fast tier alone, so the strong tier's provider's key is not
  // handed to a replay that has no subagent tool.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: { ...env, AGENT_MODEL_STRONG: "mistral/mistral-large-latest" }, launch: { ...ask, replay } })), { OPENAI_API_KEY: OPENAI_DUMMY }, "the fast tier alone beside a strong tier");
  // A revision that names agree_on has no grader: its replay is handed no key.
  const agreeOn = { kind: "agentic", body: { learning: { agree_on: ["answer"] } } };
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env, revision: agreeOn, launch: { ...ask, replay } })), {}, "a revision that names agree_on");
  // No fast tier named by the revision or the runner: the grader has no route, and no key is handed.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env: { AGENT_MODEL: env.AGENT_MODEL }, launch: { ...ask, replay } })), {}, "no fast tier");
  // A run that is no replay or audit (no subagent, no learning harness, no SDK): none of the server's keys.
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env, launch: ask })), {}, "a run of its own");
  // A replay whose launch holds a model key of its own: the server's keys are not its to spend.
  await store.agents.create({ id: "agent-own", name: "Own" }, { id: "rev-own", kind: "agentic", body: {} });
  const keyed = { ...ask, replay };
  await store.runs.create({ id: "run-own", agentId: "agent-own", revisionId: "rev-own" }, { body: launchBody(keyed), sealed: sealRunLaunch(KEY, "run-own", { model: { key: "sk-fake-run-own", origin: "https://gateway.invalid" } }) });
  assert.deepEqual(await tierKeysHanded(heldOf(store, { env, launch: keyed })), {}, "a replay keyed by its own launch");
});

test("the settings a run's process reads are the server's shared configuration and its own run's and agent's rows: another run's SDK record is refused unread, and a listing holds only the readable rows", async () => {
  const rows = [
    { key: "tool-settings", value: "{}" },
    { key: "sdk-run:run-own", value: "own" },
    { key: "sdk-run:run-other", value: "another run's messages" },
    { key: "archil.agent.agent-other", value: "{}" },
    { key: "archil.agent.agent-own", value: "{}" },
  ];
  const asked = [];
  const store = { settings: { get: async (key) => (asked.push(key), rows.find((row) => row.key === key)?.value), all: async () => rows } };
  const bound = { claim: { runId: "run-own", epoch: 1 }, agentId: "agent-own", revisionId: "rev-own" };
  const lines = [];
  const call = (method, args) => host.storeCall(store, method, args, bound, (line) => void lines.push(line));
  await assert.rejects(call("settings.get", ["sdk-run:run-other"]), /of another run or agent/);
  await assert.rejects(call("settings.get", ["archil.agent.agent-other"]), /of another run or agent/);
  assert.deepEqual(asked, [], "a refused read reached the store");
  assert.equal(await call("settings.get", ["sdk-run:run-own"]), "own");
  assert.equal(await call("settings.get", ["tool-settings"]), "{}");
  assert.deepEqual((await call("settings.all", [])).map(({ key }) => key), ["tool-settings", "sdk-run:run-own", "archil.agent.agent-own"]);
  assert.ok(lines.some((line) => /asked the store for settings\.get, which a run's process may not/.test(line)), lines.join("\n"));
});

test("a run's process reads no channel post: a webhook post, its own run's or another's, is refused unread", async () => {
  const asked = [];
  const store = { channels: { get: async (id) => (asked.push(id), { id, runId: "run-other", body: { title: "another run's" } }) } };
  const bound = { claim: { runId: "run-own", epoch: 1 }, agentId: "agent-own", revisionId: "rev-own" };
  const lines = [];
  await assert.rejects(host.storeCall(store, "channels.get", ["post-1"], bound, (line) => void lines.push(line)), /may not call the store's channels\.get/);
  assert.deepEqual(asked, [], "a refused read reached the store");
  assert.ok(lines.some((line) => /asked the store for channels\.get, which a run's process may not/.test(line)), lines.join("\n"));
});

test("a run that runs no agent's code here stays in its runner: a learning run, an SDK backend run, a CLI capture and a native run; any other run is a process of its own", () => {
  assert.equal(typeof host.runsInRunner, "function", "the runner says which runs stay in it");
  assert.equal(host.runsInRunner("learning", {}), true, "a learning run");
  assert.equal(host.runsInRunner("claude-agent", { sdk: { runtime: "claude-agent-sdk", instructions: "Policy." } }), true, "an SDK backend run");
  assert.equal(host.runsInRunner("pi", { native: { runtime: "claude-code", remote: { connector_id: "c-1" } } }), true, "a native run");
  assert.equal(host.runsInRunner("cli", { cli_learning: { runtime: "codex-cli", connection_id: "connection", session_id: "session", turn_id: "turn" } }), true, "a source CLI capture runs no agent code here");
  for (const harness of ["pi", "claude-agent", "codex", "cli"]) assert.equal(host.runsInRunner(harness, {}), false, harness);
});

/** staysInRunner's deps for a run of a revision of `kind`, with Claude Code's login on this machine turned on when
 *  `login` (true: AgentRun's own folder; else the place named); run "run-keyed" holds a model key of its own
 *  (model_key), sealed on its launch as the server seals it. `live`: the runner rows the store says are fresh. */
function staysDeps(data, kind, login, live = []) {
  const sealKey = randomBytes(32);
  const modelKeyed = sealRunLaunch(sealKey, "run-keyed", { model: { key: "sk-fake-run-own", origin: "https://gateway.invalid" } });
  return {
    data,
    env: {},
    sealKey,
    store: {
      runs: { get: async (id) => ({ id, agentId: "agent-own", revisionId: "rev-own" }), launch: async (id) => ({ sealed: id === "run-keyed" ? modelKeyed : null }) },
      agents: { revision: async () => ({ id: "rev-own", kind, body: {} }) },
      settings: { get: async (key) => (key === "claude_login" && login ? settingFor(login === true ? "agentrun" : login, data) : null) },
      runners: { live: async () => live },
    },
  };
}
// Where each run is a user of its own (the image's helper), and where every run is the runner's own user: by
// AGENTRUN_RUN_USER=same, or a local install with no helper.
const PER_RUN_USERS = { kind: "uid", helper: "/nonexistent/agentrun-runas", first: 0, slots: 1 };
const SAME_USER = { kind: "process", why: "AGENTRUN_RUN_USER=same" };
const NO_HELPER = { kind: "process", why: "no helper on this host" };
/** Whether staysInRunner keeps the run in its runner (its answer's `stays`). */
const stays = async (...args) => (await host.staysInRunner(...args)).stays;

test("a workflow run on a server's documents directory stays in its runner, where runs have users of their own too; a run on the model keys, or on its caller's own model key under Claude Code's login, is a process of its own", async (t) => {
  assert.equal(typeof host.staysInRunner, "function", "the runner says, per run, which runs stay in it");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-stays-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const runner = { mode: "runner" };
  for (const isolation of [PER_RUN_USERS, SAME_USER, NO_HELPER]) {
    const on = (words) => `${words} (${isolation.kind}: ${isolation.why ?? "a user of its own"})`;
    assert.equal(await stays(staysDeps(data, "workflow"), "pi", { input: {}, place: runner, documents: data }, "run-own", isolation), true, on("a workflow run rooted at the server's documents directory"));
    assert.equal(await stays(staysDeps(data, "workflow"), "pi", { input: {}, place: runner }, "run-own", isolation), false, on("a workflow run with no documents directory (rooted at /tmp) is a process of its own"));
    assert.equal(await stays(staysDeps(data, "agentic"), "pi", { input: {}, place: runner, documents: data }, "run-own", isolation), false, on("an agentic run, which never reads the documents directory"));
    assert.equal(await stays(staysDeps(data, "agentic", true), "claude-agent", { input: {}, place: runner }, "run-keyed", isolation), false, on("a claude-agent run on its caller's own model key, which its CLI runs on instead of the login (cli-run-spec.ts)"));
    assert.equal(await stays(staysDeps(data, "agentic", true), "codex", { input: {}, place: runner }, "run-own", isolation), false, on("a harness the login is not for"));
    assert.equal(await stays(staysDeps(data, "agentic"), "claude-agent", { input: {}, place: runner }, "run-own", isolation), false, on("a claude-agent run on model keys, the login off"));
    assert.equal(await stays(staysDeps(data, "agentic"), "learning", { input: {}, place: runner }, "run-own", isolation), true, on("runsInRunner's runs too"));
  }
});

test("where runs have users of their own, a claude-agent run on AgentRun's own login folder, with no model_key of its own, is a process of its own (handed the login's access token alone), never refused; where runs are the server's own user it stays in the runner", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  assert.equal(await stays(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "claimed as a process of its own user, on the login's token");
  assert.equal(await stays(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", SAME_USER), true, "AGENTRUN_RUN_USER=same: the run stays in the runner, as the server's user, and runs on the login");
  assert.equal(await stays(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", NO_HELPER), true, "a local install with no helper: the same");
  assert.equal(await stays(staysDeps(data, "agentic", true), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "a run on its caller's own model key is a process of its own, never refused");
});

test("where runs have users of their own, a claude-agent run on this machine's own Claude Code login (~/.claude) is refused at its claim, in words naming that login, AgentRun's own folder, AGENTRUN_RUN_USER=same and model_key", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-machine-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  await assert.rejects(host.staysInRunner(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-own", PER_RUN_USERS), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /this machine's own Claude Code login \(~\/\.claude, or the CLAUDE_CONFIG_DIR AgentRun was started with\)/);
    assert.match(error.message, /AgentRun's own login folder/);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    assert.match(error.message, /model_key/);
    return true;
  });
  assert.equal(await stays(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-own", SAME_USER), true, "AGENTRUN_RUN_USER=same: it stays in the runner, on the machine's login");
  assert.equal(await stays(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "its caller's own model key: never refused");
});

test("where runs have users of their own and the login is this machine's own, a run that sends no model key (a --faux runner's, a faux-pinned one, a held one) claims with no login and is never refused for it; off faux, unpinned and not held, the same claim is refused", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-keyless-claim-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  const claimOf = (env, own) => host.staysInRunner({ ...staysDeps(data, "agentic", "machine"), env }, "claude-agent", { ...launch, ...own }, "run-own", PER_RUN_USERS);
  await assert.rejects(claimOf({}, {}), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good: ${error.stack}`);
    assert.equal(error.message, host.LOGIN_MACHINE_NEEDS_SERVER_USER);
    return true;
  }, "off faux, unpinned and not held: refused at the claim in LOGIN_MACHINE_NEEDS_SERVER_USER's words");
  const claimed = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) claimed[where] = await claimOf(env, own).then((place) => place, (error) => ({ refused: error.message }));
  assert.deepEqual(claimed, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, { stays: false, login: undefined }])), "a run that sends no model key reads no login at its claim: a process of its own, no login, never refused for one");
  // Where every run is the runner's own user (AGENTRUN_RUN_USER=same): the same claim off faux stays in the runner, on the
  // machine's login; one that sends no model key reads no login either, so it is a process of its own, not the runner's.
  const sameUser = (env, own) => host.staysInRunner({ ...staysDeps(data, "agentic", "machine"), env }, "claude-agent", { ...launch, ...own }, "run-own", SAME_USER);
  assert.deepEqual(await sameUser({}, {}), { stays: true }, "AGENTRUN_RUN_USER=same, off faux: it stays in the runner, on the machine's login");
  const placed = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) placed[where] = await sameUser(env, own);
  assert.deepEqual(placed, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, { stays: false, login: undefined }])), "AGENTRUN_RUN_USER=same: a run that sends no model key is a process of its own, with no login, never in the runner on it");
});

// The runners on a data folder say at their start whether their runs on the login stay in their own process
// (claude-login-token.ts sayLoginRunner); a name the module does not export reads as undefined below.
const loginToken = await import("../dist/claude-login-token.js").catch(() => ({}));

test("where runs have users of their own, a claude-agent run on the login is refused at its claim while a runner on the same data folder whose login runs stay in its own process is live, in words naming that runner; not once it is stale or starts with users of its own", async (t) => {
  assert.equal(typeof loginToken.sayLoginRunner, "function", "a runner says on the data folder how its runs on the login run");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-q5-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  const fresh = [{ runner: "runner-own" }, { runner: "runner-beside" }];
  loginToken.sayLoginRunner(data, "runner-beside", "process");
  loginToken.sayLoginRunner(data, "runner-own", "uid");
  await assert.rejects(host.staysInRunner(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", PER_RUN_USERS), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /runner runner-beside on the same data folder/);
    assert.match(error.message, /stop runner-beside/);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    assert.match(error.message, /model_key/);
    return true;
  });
  assert.equal(await stays(staysDeps(data, "agentic", true, [{ runner: "runner-own" }]), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "the in-process runner's row is stale: claimed");
  assert.equal(await stays(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "its caller's own model key: never refused");
  assert.equal(await stays(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", SAME_USER), true, "this runner's own login runs stay in it too: never refused");
  loginToken.sayLoginRunner(data, "runner-beside", "uid");
  assert.equal(await stays(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "runner-beside started again with users of its own: claimed");
});

test("every token of the login the runner hands a run's process (held claudeLogin), a renewed one included, is carried into the runner's own redactor for that run before it is handed: model text that repeats it is cut from the run's journal as the runner writes it, from what it stages and from its rows", async (t) => {
  const { cutDeep, heldRedactor, keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-cut-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  // AgentRun's own login folder, turned on for this machine, signed in: the pinned CLI's file shape, every value fake.
  await store.settings.put("claude_login", settingFor("agentrun", data));
  const dir = join(data, "claude-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (accessToken, expiresAt, refreshToken) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null } }), { mode: 0o600 });
  const first = `not-a-secret-login-access-${randomBytes(6).toString("hex")}`;
  const refresh = `not-a-secret-login-refresh-${randomBytes(6).toString("hex")}`;
  write(first, Date.now() + 3_600_000, refresh);
  // The runner's one redactor, as runner.ts makes it (heldRedactor): it knows none of the login's values yet.
  const cut = heldRedactor(keepText);
  const launch = { input: { content: "Hello." }, harness: "claude-agent", place: { mode: "runner" } };
  // The login as the run's claim read it (staysInRunner), where each run is a user of its own.
  const { login: claimedLogin } = await host.staysInRunner({ store, sealKey: KEY, env: {}, data }, "claude-agent", launch, "run-own", PER_RUN_USERS);
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision: { kind: "agentic", body: { harness: "claude-agent" } }, claimed: {}, login: claimedLogin };
  const held = host.heldFor({ store, sealKey: KEY, env: {}, data }, reads, cut, () => {}).held;
  const login = await held.claudeLogin();
  assert.ok(login, "a run on AgentRun's own login folder is handed its reader");
  // What the runner writes for the run, each with model text that repeats `token`: a journal batch as the run's process
  // commits it (the runner's journal cuts it by what the run carries: runner.ts fenced), a staged entry (journalTarget's
  // stage), and its row's summary.
  const written = (token) => {
    const said = `The CLI printed ${token}; again: ${token}`;
    const batch = [[{ table: "entries", value: { kind: "message", data: { role: "assistant", content: [{ type: "text", text: said }] } } }]];
    const carried = cut.carried("run-own");
    return [
      ["journal", JSON.stringify(carried ? cutDeep(batch, carried, true) : batch)],
      ["staged", JSON.stringify(cutDeep({ run: { state: "failed", summary: said } }, cut))],
      ["row", cut(said)],
    ];
  };
  assert.equal(await login.token(), first);
  for (const [where, text] of written(first)) assert.ok(!text.includes(first), `the handed token is cut from the run's ${where}: ${text}`);
  // Near its end: the runner renews it (the pinned CLI's request, on the global fetch, faked) and hands the new one.
  const renewed = `not-a-secret-login-renewed-${randomBytes(6).toString("hex")}`;
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: renewed, refresh_token: `not-a-secret-login-refresh-${randomBytes(6).toString("hex")}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => (globalThis.fetch = real));
  write(first, Date.now() + 60_000, refresh);
  assert.equal(await login.token(), renewed, "renewed, and handed");
  for (const token of [first, renewed]) {
    for (const [where, text] of written(token)) assert.ok(!text.includes(token), `${token === first ? "the first" : "the renewed"} token is cut from the run's ${where}: ${text}`);
  }
});

test("where runs have users of their own, a turn-on that lands after a claim read the login as off never has the runner hand that run's process the login's token, and a turn-off between a claim on the login and its start hands that run no login: its start is refused in fixed words that name no folder, never left on the login or to a model key", async (t) => {
  const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-once-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const deps = { store, sealKey: KEY, env: {}, data };
  const launch = { input: { content: "Hello." }, harness: "claude-agent", place: { mode: "runner" } };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision: { kind: "agentic", body: { harness: "claude-agent" } }, claimed: {} };
  const turnOn = () => store.settings.put("claude_login", settingFor("agentrun", data));
  // The claim reads the login as off; the owner's turn-on lands between that read and the run's process's ask of its
  // runner for the login.
  const claimedOff = await host.staysInRunner(deps, "claude-agent", launch, "run-own", PER_RUN_USERS);
  await turnOn();
  const handed = await host.heldFor(deps, { ...reads, login: claimedOff.login }, heldRedactor(keepText), () => {}).held.claudeLogin();
  assert.equal(handed, undefined, "a run claimed while the login was off is handed no login token: the turn-on after its claim never moves it onto the server user's login");
  assert.equal(claimedOff.stays, false, "claimed as a process of its own, on the model keys");
  // Claimed on the login (AgentRun's own folder); the owner's turn-off lands before the run's process asks.
  const claimedOn = await host.staysInRunner(deps, "claude-agent", launch, "run-own", PER_RUN_USERS);
  assert.equal(claimedOn.stays, false, "claimed as a process of its own, on the login's token");
  await store.settings.remove("claude_login");
  await assert.rejects(host.heldFor(deps, { ...reads, login: claimedOn.login }, heldRedactor(keepText), () => {}).held.claudeLogin(), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /turned off or moved to another folder since this run's claim/);
    assert.match(error.message, /model_key/);
    assert.ok(!error.message.includes(data), `the refusal names no folder: ${error.message}`);
    return true;
  }, "a run claimed on the login whose login was turned off before its start is handed no login: its start is refused, never left on the login its claim read");
});

test("where runs have users of their own, the runner reads the login's setting again at a run's start: the same folder as its claim read hands the run that login's reader, and a setting moved to another folder since its claim hands it none, its start refused in fixed words that name no folder", async (t) => {
  const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-reread-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  // A scratch home and CLI folder: the machine's own login place names these, never the person's.
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-reread-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude-config") };
  const deps = { store, sealKey: KEY, env, data };
  const launch = { input: { content: "Hello." }, harness: "claude-agent", place: { mode: "runner" } };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision: { kind: "agentic", body: { harness: "claude-agent" } }, claimed: {} };
  const startOf = (login) => host.heldFor(deps, { ...reads, login }, heldRedactor(keepText), () => {}).held.claudeLogin();
  // Claimed on AgentRun's own folder, and still on it at the start: handed its reader, as before.
  await store.settings.put("claude_login", settingFor("agentrun", data));
  const claimed = await host.staysInRunner(deps, "claude-agent", launch, "run-own", PER_RUN_USERS);
  assert.equal(claimed.stays, false, "claimed as a process of its own, on the login's token");
  assert.equal(typeof (await startOf(claimed.login))?.token, "function", "the same folder at its claim and its start: the run is handed that login's reader");
  // The owner moves the login to this machine's own folder between the claim's read and the start.
  await store.settings.put("claude_login", settingFor("machine", data));
  await assert.rejects(startOf(claimed.login), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /turned off or moved to another folder since this run's claim/);
    for (const folder of [data, home]) assert.ok(!error.message.includes(folder), `the refusal names no folder: ${error.message}`);
    return true;
  }, "a run claimed on one folder whose setting names another at its start is handed no login: neither the folder its claim read nor the one its start reads");
});

test("the runner's reader of the login (held claudeLogin) says each renewal's outcome on the runner's own log, in the server's log line under event claude_login: a post with no answer, one Anthropic refuses and a renewal whose save fails, each by its words alone, no line holding a token or the login file's text", async (t) => {
  const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-log-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await store.settings.put("claude_login", settingFor("agentrun", data));
  const dir = join(data, "claude-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, ".credentials.json");
  const value = (what) => `not-a-secret-login-${what}-${randomBytes(6).toString("hex")}`;
  const textOf = (accessToken, refreshToken) => JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 60_000, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null } });
  const first = { access: value("access"), refresh: value("refresh") };
  const second = { access: value("access-2"), refresh: value("refresh-2") };
  const renewed = { access: value("renewed"), refresh: value("renewed-refresh") };
  writeFileSync(file, textOf(first.access, first.refresh), { mode: 0o600 });
  const launch = { input: { content: "Hello." }, harness: "claude-agent", place: { mode: "runner" } };
  const { login: claimedLogin } = await host.staysInRunner({ store, sealKey: KEY, env: {}, data }, "claude-agent", launch, "run-own", PER_RUN_USERS);
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision: { kind: "agentic", body: { harness: "claude-agent" } }, claimed: {}, login: claimedLogin };
  const lines = [];
  const login = await host.heldFor({ store, sealKey: KEY, env: {}, data }, reads, heldRedactor(keepText), (line) => void lines.push(line)).held.claudeLogin();
  assert.ok(login, "a run on AgentRun's own login folder is handed its reader");
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  // Near its end, the renewal's post gets no answer; then Anthropic refuses its refresh token for good.
  globalThis.fetch = async () => {
    throw new Error(`no answer, the request held ${first.refresh}`);
  };
  await assert.rejects(login.token(), /less than 5 minutes/);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: `refused ${first.refresh}` }), { status: 400, headers: { "content-type": "application/json" } });
  await assert.rejects(login.token(), /less than 5 minutes/);
  // Signed in again; the login's file is reached through a link now, which the runner never replaces: the renewal lands
  // and its save fails, so its pair is held.
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, textOf(second.access, second.refresh), { mode: 0o600 });
  rmSync(file);
  symlinkSync(elsewhere, file);
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: renewed.access, refresh_token: renewed.refresh, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await login.token(), renewed.access, "renewed, its save failed: the held token is handed");
  const said = lines.filter((line) => /(^| )event=claude_login( |$)/.test(line));
  const has = (...words) => said.some((line) => words.every((word) => line.split(" ").includes(word)));
  assert.ok(has("claude_login=renew_failed", "reason=network"), `the runner's log says the renewal whose post got no answer: ${JSON.stringify(lines)}`);
  assert.ok(has("claude_login=renew_refused", "status=400", "error=invalid_grant"), `the runner's log says the renewal Anthropic refused, by its status and error code: ${JSON.stringify(lines)}`);
  assert.ok(has("claude_login=renewed", "saved=no", "reason=held"), `the runner's log says the renewal whose save failed: ${JSON.stringify(lines)}`);
  for (const line of lines) {
    for (const secret of [first.access, first.refresh, second.access, second.refresh, renewed.access, renewed.refresh]) assert.ok(!line.includes(secret), `no token in the runner's log: ${line}`);
    for (const text of [textOf(first.access, first.refresh), readFileSync(elsewhere, "utf8")]) assert.ok(!line.includes(text), `no file text in the runner's log: ${line}`);
  }
});

test("the runner's answer to held claudeLogin is the claim's one decision whether it goes on the login: none with the login off, and a claim on this machine's own login refused in words, never left to a model key", async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-answer-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
  // A scratch home and CLI folder: this machine's own login place names these, never the person's.
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-answer-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude-config") };
  const deps = { store, sealKey: KEY, env, data };
  const launch = { input: { content: "Hello." }, harness: "claude-agent", place: { mode: "runner" } };
  // `login`: the claim's one read of the login (staysInRunner), which the runner hands down to the run's start.
  const startOf = (login) => host.heldFor(deps, { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision: { kind: "agentic", body: { harness: "claude-agent" } }, claimed: {}, login }, heldRedactor(keepText), () => {}).held.claudeLogin();
  const off = await host.staysInRunner(deps, "claude-agent", launch, "run-own", PER_RUN_USERS);
  assert.equal(off.login, undefined, "the login off: the claim reads none");
  assert.equal(await startOf(off.login), undefined, "and the run's start is handed none, so it goes on the model keys");
  // This machine's own login, where runs have users of their own: the claim refuses it, so no start is ever handed it.
  await store.settings.put("claude_login", settingFor("machine", data));
  await assert.rejects(host.staysInRunner(deps, "claude-agent", launch, "run-own", PER_RUN_USERS), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good: ${error.stack}`);
    assert.equal(error.message, host.LOGIN_MACHINE_NEEDS_SERVER_USER);
    return true;
  }, "a claim on this machine's own login is refused at the claim in LOGIN_MACHINE_NEEDS_SERVER_USER's words, never answered none and left to a model key");
});

test("a run that sends no model key (a --faux runner's, a faux-pinned one, a held one) is answered no reader of the Claude login (held claudeLogin), whatever its claim read; off faux, unpinned and not held, its reader", async (t) => {
  const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-keyless-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  // AgentRun's own login folder, turned on for this machine, signed in: the pinned CLI's file shape, every value fake.
  await store.settings.put("claude_login", settingFor("agentrun", data));
  const dir = join(data, "claude-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const accessToken = `not-a-secret-login-access-${randomBytes(6).toString("hex")}`;
  const refreshToken = `not-a-secret-login-refresh-${randomBytes(6).toString("hex")}`;
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null } }), { mode: 0o600 });
  const place = { mode: "runner" };
  // The login as the claim read it (staysInRunner's loginForRun): the same read for each run below.
  const login = await loginForRun(store.settings, data, {}, "claude-agent", place);
  assert.ok(login, "the claim read AgentRun's own login folder");
  const revision = { kind: "agentic", body: { harness: "claude-agent" } };
  const answerOf = (env, own) => heldOf(store, { env, data, revision, launch: { input: { content: "Hello." }, harness: "claude-agent", place, ...own }, login, cut: heldRedactor(keepText) }).claudeLogin();
  // The control: off faux, unpinned and not held, the same claim is handed the login's reader.
  const handed = await answerOf({}, {});
  assert.equal(typeof handed?.token, "function", "off faux, unpinned and not held: the run is handed the login's reader");
  // Each run that sends no model key: none, whatever its process asks.
  const answered = {};
  for (const [where, env, own] of SENDS_NO_MODEL_KEY) answered[where] = typeof (await answerOf(env, own))?.token;
  assert.deepEqual(answered, Object.fromEntries(SENDS_NO_MODEL_KEY.map(([where]) => [where, "undefined"])), "a run that sends no model key is handed no reader of the Claude login's token");
});

test("the install a run's process asks for is readable by every user and writable by none, an install from before installs were shared too", { skip: process.getuid?.() === 0 && "root reads every folder" }, async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-install-"));
  t.after(() => (chmodTree(data), rmSync(data, { recursive: true, force: true })));
  // An install as one before installs were shared left it: its top folder its owner's alone, as its staging was made.
  const dir = join(data, "harnesses", "claude-agent");
  mkdirSync(join(dir, "node_modules", "sdk"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "sdk", "index.js"), "export {};\n", { mode: 0o644 });
  writeFileSync(join(dir, "node_modules", "sdk", "cli"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(dir, "node_modules", "sdk", "index.js"), 0o400);
  chmodSync(join(dir, "node_modules", "sdk", "cli"), 0o500);
  chmodSync(join(dir, "node_modules", "sdk"), 0o500);
  chmodSync(join(dir, "node_modules"), 0o500);
  chmodSync(dir, 0o500);
  const asked = [];
  const deps = { store, sealKey: KEY, env: {}, data, installForClaim: async (entry, at) => void asked.push([entry.id, at]) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." }, harness: "claude-agent" }, revision: { kind: "agentic", body: {} }, claimed: {} };
  const held = host.heldFor(deps, reads, (text) => text, () => {}).held;
  await held.install("claude-agent");
  assert.deepEqual(asked, [["claude-agent", dir]], "the runner installed (or found) the harness");
  const mode = (path) => statSync(path).mode & 0o777;
  assert.equal(mode(dir), 0o555, "its top folder is entered and listed by every user");
  assert.equal(mode(join(dir, "node_modules", "sdk")), 0o555, "and every folder under it");
  assert.equal(mode(join(dir, "node_modules", "sdk", "index.js")), 0o444, "a file is read by every user, written by none");
  assert.equal(mode(join(dir, "node_modules", "sdk", "cli")), 0o555, "a program its owner may run, run by every user");
});

test("the computer the runner made for a run is released by the runner at the claim's release, whatever its process did: once, as the run's end", async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-computer-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const released = [];
  const deps = { store, sealKey: KEY, env: {}, data, computerForClaim: async () => ({ release: async (why) => void released.push(why ?? "released") }) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision: { kind: "agentic", body: {} }, claimed: {} };
  const side = host.heldFor(deps, reads, (text) => text, () => {});
  const got = await side.held.computer({ hadComputer: async () => false });
  assert.equal(typeof got.release, "function");
  // The run's process ends (a crash, a broken channel) without calling the computer's release.
  await side.release();
  assert.deepEqual(released, ["ended"], "the runner let the computer go at the claim's release");
});

test("a run's process is handed its runner's live address with its own run's proof key: a proof for its run's viewers holds, one for another run's or under the runners' shared key does not", async (t) => {
  const { store } = await storeOn(t);
  const held = heldOf(store, { env: { AGENTRUN_RUNNER_LIVE_HOST: "127.0.0.2" } });
  assert.equal(typeof held.liveAt, "function", "the runner hands the run's process no address its viewers answer at");
  const given = await held.liveAt();
  assert.equal(given.host, "127.0.0.2");
  const key = Buffer.from(given.key);
  const reach = live.liveReachOf({ AGENTRUN_RUNNER_HOSTS: "127.0.0.2" }, KEY);
  const req = (proof) => ({ headers: { [live.LIVE_PROOF_HEADER]: proof } });
  assert.equal(live.provenFor(req(live.liveProof(live.reachForRun(reach, "run-own"), "viewer-1")), { key }, "viewer-1"), true, "the server's proof for this run's viewer");
  assert.equal(live.provenFor(req(live.liveProof(live.reachForRun(reach, "run-other"), "viewer-1")), { key }, "viewer-1"), false, "another run's proof");
  assert.equal(live.provenFor(req(live.liveProof(reach, "viewer-1")), { key }, "viewer-1"), false, "a proof under the runners' shared key");
  assert.notDeepEqual(key, reach.key, "the run's process never holds the runners' shared key");
  assert.equal(await heldOf(store).liveAt(), undefined, "a runner on its server's machine: none");
});

test("a function handed across the channel is let go by its sender once the receiver's stand-in for it is gone", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const [a, b] = duplexPair();
  const runner = new Channel(a);
  const child = new Channel(b);
  const handed = [];
  // As a hold's enter answers a fresh release function each time (computer-for-claim.ts).
  runner.expose("hold", () => {
    const release = () => "released";
    handed.push(new WeakRef(release));
    return release;
  });
  for (let i = 0; i < 20; i++) {
    const release = await child.call("hold", "enter", []);
    assert.equal(await release(), "released");
  }
  // A deref keeps its target alive to the end of the job it ran in: each gc runs in a job of its own, after the reads.
  const kept = () => handed.filter((ref) => ref.deref() !== undefined).length;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 100 && kept() > 1; i++) {
    await tick();
    gc();
    await tick();
  }
  // The last stand-in may still be the loop's own; every earlier one is gone.
  const left = kept();
  assert.ok(left <= 1, `the runner still holds ${left} of the ${handed.length} release functions it handed, each released and its stand-in gone`);
  assert.equal(runner.handed, left, "what the runner counts as handed is what it holds");
  runner.close();
  child.close();
});

// A Mode 2 run's folder is its runner's Workspace on the run's disk, which its process holds by handle (held.ts archil,
// archil-claim.ts archilWhereHeld): a write through it is a call of the run's channel, one frame. A write bigger than a
// frame crosses in pieces the runner pulls, and the runner writes the file once, on that Workspace (runner/big-writes.ts).
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { saveSlots } = await import("../dist/web-save.js");
const { setHeld } = await import("../dist/runner/held.js");
const { archilWhereHeld } = await import("../dist/workspace/archil-claim.js");
const { openRunWorkspace } = await import("../dist/workspace/run-workspace.js");
const bigWrites = await import("../dist/runner/big-writes.js").catch(() => ({}));

test("a Mode 2 run's process writes a file bigger than its channel's frame through its held Workspace: its runner pulls the pieces and writes it once, byte for byte", async (t) => {
  const { store } = await storeOn(t);
  const DISK = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
  await saveArchilSettings(store, DISK);
  await storeAgentDisk(store, "agent-own", { diskId: DISK.diskId });
  await store.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  const disk = new FakeArchilDisk();
  const control = archilControlFetch();
  const deps = { store, sealKey: KEY, env: {}, data: "/nonexistent-data", makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision: { kind: "agentic", body: {} }, claimed: {} };
  // A channel of 1 MiB frames, its runner's side as the runner wires it (runChannel, heldFor's answers as "held"), the
  // pieces a quarter of a frame.
  const FRAME = 1024 * 1024;
  const bigs = bigWrites.runBigWrites?.({ gate: saveSlots(4), piece: FRAME / 4 });
  const side = bigs ? host.heldFor(deps, reads, (text) => text, () => {}, bigs) : host.heldFor(deps, reads, (text) => text, () => {});
  const [runnerEnd, childEnd] = duplexPair();
  const runner = host.runChannel(runnerEnd, () => {}, saveSlots(4), { ...(bigs ? { bigs } : {}), maxFrame: FRAME });
  runner.expose("held", (method, args) => side.held[method](...args));
  const child = new Channel(childEnd, { maxFrame: FRAME });
  t.after(async () => { setHeld(undefined); child.close(); runner.close(); await side.release(); });
  // The run's process opens its folder as a Mode 2 claim's does: the Workspace its runner opened on the disk.
  setHeld(child.remote("held"));
  const claim = await archilWhereHeld({ signal: new AbortController().signal });
  const ws = (await openRunWorkspace({ mode: 2, agentId: "agent-own", runId: "run-own", archil: claim, log: () => {} })).workspace;
  const bytes = randomBytes(3 * FRAME + 123);
  await ws.write("media/big.bin", bytes);
  // Read back on the runner's side of the disk (a read of it would not fit the channel's frame either).
  const there = await (await side.held.archil()).workspace.read("media/big.bin");
  assert.equal(Buffer.compare(Buffer.from(there), bytes), 0, "the file on the disk is the bytes written");
  const puts = disk.calls.filter((call) => call.key?.endsWith("/media/big.bin") && call.op !== "getRange" && call.op !== "head");
  assert.deepEqual(puts.map((call) => [call.op, call.size]), [["putObject", bytes.length]], "the runner wrote it once, whole");
  // A write of one piece or less is one call, as before.
  await ws.write("media/small.txt", "small");
  assert.equal(Buffer.from(await (await side.held.archil()).workspace.read("media/small.txt")).toString(), "small");
});

test("a run's own process never reads the login's setting itself: with the login turned on since its claim and its runner handing it no login, it starts on none; one its runner hands a reader starts on that reader alone, each token held; a run in the runner reads the setting", async (t) => {
  const spec = await import("../dist/runner/cli-run-spec.js");
  assert.equal(typeof spec.runLoginOf, "function", "the login a run starts on is one step (cli-run-spec.ts runLoginOf)");
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-start-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  t.after(() => setHeld(undefined));
  // The owner turned the login on (AgentRun's own folder) after the run's claim read it as off: its runner hands none.
  await store.settings.put("claude_login", settingFor("agentrun", data));
  const place = { mode: "runner" };
  const held = [];
  const hold = (values) => void held.push(...values);
  setHeld({ claudeLogin: async () => undefined });
  assert.equal(await spec.runLoginOf({ store, data, env: {} }, false, "claude-agent", place, hold), undefined, "a run's own process whose runner handed it no login starts on none: it never reads the login's setting, turned on since its claim, itself");
  // Claimed on the login: its runner hands its reader of the access token, which the process holds before its CLI has a token.
  const token = `not-a-secret-login-access-${randomBytes(6).toString("hex")}`;
  setHeld({ claudeLogin: async () => ({ token: async () => token, refused: async () => {} }) });
  const handed = await spec.runLoginOf({ store, data, env: {} }, false, "claude-agent", place, hold);
  assert.equal(await handed?.token(), token, "the reader its runner handed");
  assert.deepEqual(held, [token], "each token held by the run's redactors");
  assert.equal(await spec.runLoginOf({ store, data, env: {} }, true, "claude-agent", place, hold), undefined, "a run on its own model key starts on no login");
  // A run in the runner itself (a seal key) reads the setting: AgentRun's own login folder.
  const inRunner = await spec.runLoginOf({ store, data, env: {}, sealKey: KEY }, false, "claude-agent", place, hold);
  assert.equal(inRunner?.dir, join(data, "claude-login"), "a run in the runner starts on the login's folder, as the setting names it");
});
