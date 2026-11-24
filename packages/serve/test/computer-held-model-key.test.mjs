// A held run (computer-held.ts) whose model can't run here: no key for it, its harness refusing it (a CLI harness that
// runs here but for want of a model key among them), no price under a cap.
// Its create is not refused for that: a benchmark's held run only calls the computer and lets it go, and never needs the
// model. The words the create would have said ride the run's launch (hold.refused): its start and every message are
// refused in them (409 agent_not_runnable), and its computer still takes calls until the release or the hold's lapse.
// Any other blocker still refuses the create, and so does a model gateway with no key here (422 model_key_required).
// The create resolves no model for such a run: its launch pins none.
//
// Its claim chooses no model and reads no key, on pi (adapter-run-spec.ts) and on every CLI harness (cli-run-spec.ts):
// its provider is a stand-in whose session proxy refuses every model request in the create's words, sending none. A
// claim of a run that is not held chooses its model as before, and fails on a host with no key for it.
//
// The served case runs on a server with no model key at all: its runner beside it builds the run's spec as it really
// does (adapter-run-spec.ts), on a fake claim-time computer (computerForClaim, the runner's seam) and a fake `docker` first
// on PATH for the create's sandbox check, so nothing is rented and no model is reached. The waits are on events: the
// claim asking for its computer, the routes' own answers (each waits for the runner to take its row), the computer let go.
// The stand-ins are asked through the model proxy every session runs on (startModelProxy), its provider a counting fake
// fetch: what left is counted, never timed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { readBackOf } from "@parcha/agentrun-computer";
import { GATEWAY_KEY_ENV, MODEL_KEYS } from "../dist/model.js";
import { specFor } from "./runner-spec-support.mjs";
import { agent, scratch, serve, withEnv } from "./support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { message, prepareLaunch } = await import("../dist/runs-over-store.js");
const { openFeedbackRound } = await import("../dist/runner/feedback-round.js");
const { journalHeld } = await import("../dist/runner/held-run.js");
const { heldIn } = await import("../dist/computer-held.js");
const { CALL_KIND } = await import("../dist/computer-channel.js");
const { ApiError } = await import("../dist/errors.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { heldRefusedRoute } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { claimSecrets, MODEL_KEY_NAMES } = await import("../dist/runner/claim-secrets.js");
const { childLoops, heldFor } = await import("../dist/runner/run-child-host.js");
const { launchBody } = await import("../dist/run-launch.js");
const { saveGateway } = await import("../dist/model-gateway.js");
const { claudeOf, codexOf, opencodeOf, CODEX_STANDIN_ENV, OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { blockersOf } = await import("../dist/runnable.js");
const { startModelProxy } = await import("@parcha/agentrun-kernel/host");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";

const MODEL = "openrouter/anthropic/claude-sonnet-5.5";
const KEY_WORDS = /No OpenRouter key here for openrouter\/anthropic\/claude-sonnet-5\.5/;
/** Every name a model or a web search could be reached by here: none is set, so this host has no model key. */
const KEYLESS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "PARALLEL_API_KEY", "AGENTRUN_BOXES", ...MODEL_KEYS.map((row) => row.field)];
/** A held run's model refusal as its launch keeps it (run-launch.ts hold.refused), for the cases with no server. */
const REFUSAL = {
  message: "No OpenRouter key here for openrouter/anthropic/claude-sonnet-5.5: add one in Settings → Model keys, or set OPENROUTER_API_KEY where AgentRun starts.",
  fields: [{ field: "definition.model", reason: "not_runnable", message: "No OpenRouter key here for openrouter/anthropic/claude-sonnet-5.5." }],
  details: { unbound: [], missing: {} },
};
const HELLO = { protocol: "0.2", version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["files", "exec", "process"] };
const PHONE = { kind: "phone", provider: "phone-harness" };
/** A run's own key for a model gateway, a test's: never a real one. */
const GATEWAY_KEY = "not-a-secret-held-gateway-key";
/** A model key and a tool key this host holds, a test's: never real ones. */
const HOST_MODEL_KEY = "not-a-secret-held-host-model-key";
const HOST_TOOL_KEY = "not-a-secret-held-host-tool-key";
/** OpenCode's stand-in (fixtures/fake-opencode-serve.mjs), which speaks `opencode serve`'s protocol: no CLI is installed
 *  for the served opencode cases. */
const OPENCODE_STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
/** The words opencode is refused in on a host with no model key for it (provider.ts providerFor, OpenAI's wire). */
const OPENCODE_KEY_WORDS = /opencode needs OPENAI_API_KEY/;
/** A replay of a learned workflow (runner/promotion.ts), as a launch names it: no workflow by that name was ever laid. */
const REPLAY = { of: "run-0", workflow: "flow", digest: "0".repeat(64) };
/** The claim-time computer of the pi claims below: the fake computer on `root` as a phone (no mount to check). */
const phoneOn = (root) => () => ({ computerForClaim: async () => ({ computer: { kind: "phone", computer: fakeComputer(root), hello: { ...HELLO, os: "android", kind: "android" } }, release: async () => {} }) });

/** The runner's claim-time computer (computerForClaim): the fake computer as a sandbox over the run's own folder (Mode 1,
 *  a bind of it, as Docker's mount is: workspace-fake-processes.mjs sandboxForClaim), its mount checked with the computer
 *  module's readBackOf, as every real claim's is; with an event once a claim asked for it and once it was let go, and
 *  the computers it opened (`opened`), counted. `box`: the claim's computer, once a claim made it. */
function claimSeam() {
  let claim;
  let release;
  const claimed = new Promise((resolve) => (claim = resolve));
  const released = new Promise((resolve) => (release = resolve));
  const count = { opened: 0 };
  const seam = { box: undefined, claimed, released, count };
  seam.computerForClaim = async (_launch, _store, deps) => {
    const spec = await deps.workspace.mountSpec();
    if (spec?.kind !== "bind") throw new Error(`the fake sandbox binds a folder of this machine (Mode 1), not ${JSON.stringify(spec)}`);
    seam.box = fakeComputer(spec.path);
    count.opened += 1;
    claim();
    return { computer: { kind: "sandbox", computer: seam.box, hello: HELLO, check: { readBackOf } }, release: async () => release() };
  };
  return seam;
}

/** A keyless server with its runner on the seam's computer, and a fake `docker` first on PATH for the create's check.
 *  `env`: more of the server's settings (a model gateway's), none of them a key. */
async function keylessServer(t, seam, env = {}) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 27.0.0-fake; fi\nexit 0\n", { mode: 0o755 });
  withEnv(t, { PATH: [bin, process.env.PATH ?? ""].join(delimiter), ...env }, KEYLESS);
  return serve(t, { faux: undefined, ...(seam ? { computerForClaim: seam.computerForClaim } : {}) });
}

/** Runs `check` (its asserts); when one fails, its message gains run `id`'s read, so a served run that failed says how:
 *  its view (GET /runs/{id}: its state and its error's words) and its timeline's last rows (GET /runs/{id}/timeline).
 *  Read only after a failure. */
async function withRunRead(api, id, check) {
  try {
    await check();
  } catch (error) {
    const run = await api("GET", `/runs/${id}`).then((res) => res.body, (failed) => ({ unread: String(failed) }));
    const page = await api("GET", `/runs/${id}/timeline`).then((res) => res.body, (failed) => ({ unread: String(failed) }));
    error.message += `\nthe run's read: ${JSON.stringify(run)}\nits last timeline rows: ${JSON.stringify(Array.isArray(page?.rows) ? page.rows.slice(-8) : page)}`;
    throw error;
  }
}

const SANDBOX = { kind: "sandbox", provider: "docker" };
const SEAL_KEY = Buffer.alloc(32, 7);
const PROXY_KEY = "session-key-for-tests";
/** A provider's API as the proxy speaks it, the least of one (run-adapters' proxy-credential test's). */
const POLICY = {
  id: "held-test",
  routes: [{ method: "POST", path: "/v1/test" }],
  keyOf: (headers) => String(headers.authorization ?? "").replace(/^Bearer /, ""),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => undefined,
};

/** One model request through the proxy every session runs on (startModelProxy: pi's, and each CLI harness's), on
 *  `provider`'s origin and credential as the adapters hand them over: what it answered, and how many requests the runner
 *  was asked to admit and the provider was sent (the provider a counting fake fetch: nothing here reaches a network). */
async function askThrough(t, provider) {
  const count = { admitted: 0, sent: 0 };
  const proxy = await startModelProxy({
    policy: POLICY, model: "held-model", origin: provider.origin, credential: async () => provider.credential(), price: () => null, log: () => {},
    hooks: { beforeRequest: async () => ((count.admitted += 1), {}), afterRequest: async () => {} },
    fetch: async () => ((count.sent += 1), Response.json({ ok: true })),
  }, PROXY_KEY);
  t.after(() => proxy.close());
  const res = await fetch(`${proxy.url}/v1/test`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${PROXY_KEY}` }, body: "{}" });
  return { status: res.status, body: await res.json(), ...count };
}

/** `asked` (askThrough) was refused in `words`, verbatim, and no request left for a provider. */
function refusedIn(asked, words, who) {
  assert.equal(asked.body.error?.message, words, `${who}: the model request is refused in the create's words, verbatim: ${JSON.stringify(asked.body)}`);
  assert.equal(asked.body.error?.code, "credential_unavailable", `${who}: as a credential its host says is gone, which a client does not retry`);
  assert.ok(asked.status >= 400 && asked.status < 500, `${who}: a refusal, not a provider's answer: ${asked.status}`);
  assert.deepEqual({ admitted: asked.admitted, sent: asked.sent }, { admitted: 0, sent: 0 }, `${who}: nothing was admitted or sent: no request left for a provider`);
}

/** An installed SDK as claudeOf loads it (harness-install.ts loadSdk): a test's, which no adapter here runs. */
const loadedSdk = async (version) => ({ sdk: { query() {} }, sdkVersion: version, cliPath: "/nowhere/claude", mcp: { server: {}, types: {} } });

/** A claim of an opencode run of the revision model `openai/gpt-6.1-sol` on a runner with no model key, its spec built as
 *  the runner builds a CLI harness's (cli-run-spec.ts cliRunSpecFromLaunch) on the opencode stand-in and no computer (a
 *  runner place). `hold`: the launch's; `extra`: more of its launch (a replay's); `host`: more of the runner's environment,
 *  and the runner's model route (`routeOf`, which a CLI run's own model never takes). Resolves to the spec; rejects as the
 *  claim fails. */
async function cliClaim(t, hold, extra = {}, host = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let built;
  let harness;
  t.after(async () => {
    await built?.release?.().catch(() => {});
    await harness?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "opencode", model: "openai/gpt-6.1-sol", tools: ["read"] } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: "opencode", ...(hold ? { hold } : {}), ...extra };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const env = { ...host.env, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [] }), PATH: process.env.PATH };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: host.routeOf ?? (async () => assert.fail("a CLI run takes no pi route")), computerForClaim: async () => ({ release: async () => {} }) };
  built = await cliRunSpecFromLaunch(launch, { harness, registry, setModels: (given) => (models = given) }, deps, claim);
  return built;
}

test("served, no model key: a held run opens and holds its computer, its start and messages are refused in the create's own words, and its release lets the computer go", async (t) => {
  const seam = claimSeam();
  const { api } = await keylessServer(t, seam);
  const saved = await api("POST", "/agents", agent("bench", { model: MODEL, computer: SANDBOX }));
  assert.equal(saved.status, 201, `a save does not check the model's key: ${JSON.stringify(saved.body)}`);

  // (b) The control: without hold the create is refused, as before, in the key's words.
  const unheld = await api("POST", "/agents/bench/runs", { input: { content: "Do the task." } });
  assert.deepEqual([unheld.status, unheld.body.error?.code], [409, "agent_not_runnable"], `a run that is not held is refused at its create for its model: ${JSON.stringify(unheld.body)}`);
  assert.match(unheld.body.error.message, KEY_WORDS, "the refusal names the missing OpenRouter key");
  const said = unheld.body.error;

  // (a) Held, the same agent's run opens.
  const held = await api("POST", "/agents/bench/runs", { input: { content: "Do the task." }, hold: true, hold_minutes: 5 });
  assert.equal(held.status, 202, `a held run's create is not refused for its model alone: ${JSON.stringify(held.body)}`);
  const id = held.body.run_id;
  await seam.claimed;
  const call = await api("POST", `/runs/${id}/computer/call`, { method: "files.list", params: { path: "/workspace" } });
  await withRunRead(api, id, () => {
    assert.equal(call.status, 200, `the owner's call reaches the held computer: ${JSON.stringify(call.body)}`);
    assert.equal(call.body.ok, true, `the computer answered the call itself: ${JSON.stringify(call.body)}`);
  });
  assert.ok(seam.box.calls.some(([method]) => method === "files.list"), "the call ran on the claim's computer");
  const waiting = (await api("GET", `/runs/${id}`)).body.computer?.held;
  await withRunRead(api, id, () => assert.equal(waiting?.state, "waiting", `the claim opened with no model key and holds the computer for its owner: ${JSON.stringify(waiting)}`));

  // (c) Every route that would start or feed its agent is refused in the create's words.
  const start = await api("POST", `/runs/${id}/start`, {});
  assert.deepEqual([start.status, start.body.error?.code], [409, "agent_not_runnable"], `the start is refused, not sent to the runner: ${JSON.stringify(start.body)}`);
  assert.equal(start.body.error.message, said.message, "the start's refusal is the create's own words");
  assert.deepEqual([start.body.error.fields, start.body.error.details], [said.fields, said.details], "and its fields and details");
  const steer = await api("POST", `/runs/${id}/messages`, { content: "Go on." });
  assert.deepEqual([steer.status, steer.body.error?.code, steer.body.error?.message], [409, "agent_not_runnable", said.message], `a message to the waiting run, its first turn, is refused in the same words: ${JSON.stringify(steer.body)}`);
  assert.equal((await api("GET", `/runs/${id}`)).body.computer?.held?.state, "waiting", "nothing moved the hold: the refusals sent the runner nothing");
  const again = await api("POST", `/runs/${id}/computer/call`, { method: "files.stat", params: { path: "/workspace" } });
  assert.deepEqual([again.status, again.body.ok], [200, true], `after the refused start, the computer still takes calls: ${JSON.stringify(again.body)}`);

  const release = await api("POST", `/runs/${id}/computer/release`, {});
  await withRunRead(api, id, () => assert.deepEqual([release.status, release.body], [200, { held: { state: "released" } }], `the owner lets the computer go: ${JSON.stringify(release.body)}`));
  await seam.released;
  const late = await api("POST", `/runs/${id}/start`, {});
  assert.deepEqual([late.status, late.body.error?.code, late.body.error?.message], [409, "agent_not_runnable", said.message], `a start after the release is refused in the create's words too: ${JSON.stringify(late.body)}`);
  const after = await api("POST", `/runs/${id}/messages`, { content: "Go on." });
  assert.deepEqual([after.status, after.body.error?.code, after.body.error?.message], [409, "agent_not_runnable", said.message], `a message after the release opens no turn either: ${JSON.stringify(after.body)}`);
});

test("served, no model key: a held run that a non-model blocker keeps from running is still refused at its create", async (t) => {
  const { api } = await keylessServer(t);
  const saved = await api("POST", "/agents", agent("searcher", { model: MODEL, computer: SANDBOX, tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } }));
  assert.equal(saved.status, 201, `the searcher agent saves, its tool's key unchecked at a save: ${JSON.stringify(saved.body)}`);
  const held = await api("POST", "/agents/searcher/runs", { input: { content: "Find it." }, hold: true });
  assert.deepEqual([held.status, held.body.error?.code], [409, "agent_not_runnable"], `a hold defers the model's refusal only: ${JSON.stringify(held.body)}`);
  assert.deepEqual(held.body.error.details?.missing?.web_search, ["PARALLEL_API_KEY"], "the tool's missing key still refuses the held create");
  assert.deepEqual((await api("GET", "/agents/searcher/runs")).body.runs, [], "no run was made");
});

/** An unavailable opencode offer as a server holds it (harness.ts harnessOffers), with `extra` (its reason, its keys). */
const opencodeOffer = (extra) => ({ id: "opencode", label: "OpenCode", promises: {}, available: false, steer: false, default_model: null, models: [], free_models: [], run_memory_mib: 704, ...extra });

test("run check (blockersOf): a CLI harness unavailable here for want of a model key alone (its offer's keys) is its model's blocker, which a held create defers; one unavailable for another reason (its binary missing) is not", async () => {
  const revision = { kind: "agentic", instructions: "Answer.", harness: "opencode", model: "openai/gpt-6.1-sol", tools: [], place: { mode: "runner" } };
  const env = { PATH: process.env.PATH };
  const keyed = await blockersOf(env, revision, {}, { offers: [opencodeOffer({ reason: "opencode needs OPENAI_API_KEY, OPENROUTER_API_KEY (OpenAI's models through OpenRouter), or a gateway in AGENT_MODEL_BASE_URL.", keys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] })] });
  const lacksKey = keyed.find((b) => b.field === "definition.harness");
  assert.ok(lacksKey, `opencode unavailable here is a blocker of its own: ${JSON.stringify(keyed)}`);
  assert.equal(lacksKey.harness, "opencode", "the blocker names its harness");
  assert.equal(lacksKey.model, true, `opencode unavailable for want of a model key alone is its model's blocker (model: true), so a held create opens: ${JSON.stringify(lacksKey)}`);
  const unkeyed = await blockersOf(env, revision, {}, { offers: [opencodeOffer({ reason: "OpenCode is not installed here (npm install opencode-ai)." })] });
  const lacksBinary = unkeyed.find((b) => b.field === "definition.harness");
  assert.ok(lacksBinary, `opencode not installed is a blocker of its own: ${JSON.stringify(unkeyed)}`);
  assert.equal(lacksBinary.model, undefined, `opencode unavailable for a reason no model key fixes is not its model's blocker, so a held create is still refused: ${JSON.stringify(lacksBinary)}`);
});

test("served, no model key: a held run of opencode, a CLI harness that runs here but for want of a model key, opens and holds its computer, its start refused in the create's words; the same run not held is refused at its create in the key's words", async (t) => {
  const seam = claimSeam();
  const { api } = await keylessServer(t, seam, { [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [OPENCODE_STAND_IN] }) });
  const saved = await api("POST", "/agents", agent("coder", { harness: "opencode", model: "openai/gpt-6.1-sol", computer: SANDBOX }));
  assert.equal(saved.status, 201, `the opencode agent saves, its harness's missing key a warning at a save: ${JSON.stringify(saved.body)}`);
  const input = { content: "Do the task." };

  // The control: without hold the create is refused, in the words opencode is refused in here.
  const unheld = await api("POST", "/agents/coder/runs", { input });
  assert.deepEqual([unheld.status, unheld.body.error?.code], [409, "agent_not_runnable"], `an opencode run that is not held is refused at its create for want of a model key: ${JSON.stringify(unheld.body)}`);
  assert.match(unheld.body.error.message, OPENCODE_KEY_WORDS, "the refusal names the model key opencode needs here");
  assert.equal(unheld.body.error.details?.harness, "opencode", "and names the harness");

  const held = await api("POST", "/agents/coder/runs", { input, hold: true, hold_minutes: 5 });
  assert.equal(held.status, 202, `a held opencode run's create is not refused for its harness's missing model key alone: ${JSON.stringify(held.body)}`);
  const id = held.body.run_id;
  await seam.claimed;
  const call = await api("POST", `/runs/${id}/computer/call`, { method: "files.list", params: { path: "/workspace" } });
  await withRunRead(api, id, () => assert.deepEqual([call.status, call.body.ok], [200, true], `the owner's call reaches the held opencode run's computer: ${JSON.stringify(call.body)}`));
  const waiting = (await api("GET", `/runs/${id}`)).body.computer?.held;
  await withRunRead(api, id, () => assert.equal(waiting?.state, "waiting", `the claim opened with no model key and holds the computer for its owner: ${JSON.stringify(waiting)}`));
  const start = await api("POST", `/runs/${id}/start`, {});
  assert.deepEqual([start.status, start.body.error?.code, start.body.error?.message], [409, "agent_not_runnable", unheld.body.error.message], `the start is refused in the create's words: ${JSON.stringify(start.body)}`);

  const release = await api("POST", `/runs/${id}/computer/release`, {});
  await withRunRead(api, id, () => assert.deepEqual([release.status, release.body], [200, { held: { state: "released" } }], `the owner lets the computer go: ${JSON.stringify(release.body)}`));
  await seam.released;
});

test("served, no model key: a held run of opencode unavailable here for a reason no model key fixes (its binary missing) is still refused at its create, and no run is made", async (t) => {
  withEnv(t, {}, [OPENCODE_STANDIN_ENV]);
  const missing = join(await scratch(t), "no-opencode-here");
  const { api } = await keylessServer(t, undefined, { OPENCODE_BIN: missing });
  const saved = await api("POST", "/agents", agent("coder", { harness: "opencode", model: "openai/gpt-6.1-sol", computer: SANDBOX }));
  assert.equal(saved.status, 201, `the opencode agent saves, its harness not set up a warning at a save: ${JSON.stringify(saved.body)}`);
  const held = await api("POST", "/agents/coder/runs", { input: { content: "Do the task." }, hold: true });
  assert.deepEqual([held.status, held.body.error?.code], [409, "agent_not_runnable"], `a hold defers a model's blocker only, never a harness no model key sets up: ${JSON.stringify(held.body)}`);
  assert.equal(held.body.error.details?.harness, "opencode", "the refusal names the harness");
  assert.deepEqual((await api("GET", "/agents/coder/runs")).body.runs, [], "no run was made");
});

/** A create's deps (runs-over-store.ts StartDeps) as prepareLaunch reads them, for an agentic run of `MODEL` on a sandbox:
 *  its run check answering as server.ts runnable does on a host with no key for that model when `keyless` (a held run's
 *  model refusal returned, REFUSAL; one not held never gets this far), else as it does on a host with the key (nothing);
 *  and its model's resolution (StartDeps.modelOf) counted. */
function createDeps(keyless) {
  const count = { modelOf: 0 };
  const revision = { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", model: MODEL, computer: SANDBOX, tools: [] } };
  const deps = {
    runBodyIssues: () => [],
    pinnedOf: async () => ({ revision, version: 1 }),
    inputIssuesOf: async () => [],
    explainRun: async (issues) => issues,
    told: (error) => error,
    runnable: async (_revision, _place, { held }) => (keyless && held ? REFUSAL : undefined),
    readyFiles: async () => {},
    fallbackPlace: () => ({ mode: "runner" }),
    workflowTitle: (name) => name,
    serverSecrets: () => [],
    toolSettings: () => ({}),
    planeEnv: () => ({}),
    modelOf: async () => ((count.modelOf += 1), { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }),
  };
  return { deps, count, entry: { agent: { id: "bench", name: "bench" }, revision, version: 1 } };
}

test("create (prepareLaunch): a held run whose model was refused resolves no model, its launch pins none and carries the refusal; a run not held, and a held one whose model is fine, resolve it once", async () => {
  const input = { content: "Do the task." };
  const refused = createDeps(true);
  const { launch } = await prepareLaunch(refused.deps, refused.entry, { input, hold: true });
  assert.equal(refused.count.modelOf, 0, "a held create whose model blockers were deferred calls modelOf 0 times: resolving it would throw the same words");
  assert.equal(launch.model, undefined, "its launch pins no model: its claim takes the stand-in on the revision's model");
  assert.deepEqual(launch.hold?.refused, REFUSAL, "the deferred refusal rides its hold");

  const keyed = createDeps(false);
  const unheld = await prepareLaunch(keyed.deps, keyed.entry, { input });
  assert.equal(keyed.count.modelOf, 1, "a non-held create still calls modelOf once");
  assert.deepEqual(unheld.launch.model, { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }, "and its launch pins the model it resolved");

  const fine = createDeps(false);
  const held = await prepareLaunch(fine.deps, fine.entry, { input, hold: true });
  assert.equal(fine.count.modelOf, 1, "a held create whose model was fine still calls modelOf once");
  assert.equal(held.launch.hold?.refused, undefined, "its hold carries no refusal");
});

test("served, a model gateway with no key here: a held run whose model was refused at its create is still refused 422 model_key_required, in the words any run there gets, and no computer is opened", async (t) => {
  const seam = claimSeam();
  // A gateway on loopback that nothing listens on: nothing here asks it. No price is set, so its model has none.
  withEnv(t, {}, ["AGENT_MODEL_PRICE"]);
  const { api } = await keylessServer(t, seam, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" });
  assert.equal((await api("POST", "/agents", agent("gw", { model: "agent-model/not-a-catalog-model", computer: SANDBOX }))).status, 201, "the gateway agent saves");
  const input = { content: "Do the task." };
  const wordsOf = (error) => ({ code: error?.code, message: error?.message, fields: error?.fields });

  // The words: a held run whose model is fine (uncapped, the gateway's model runs unpriced) is refused for the key alone.
  const fine = await api("POST", "/agents/gw/runs", { input, hold: true });
  assert.deepEqual([fine.status, fine.body.error?.code], [422, "model_key_required"], `a held run on a gateway with no key is refused at its create: ${JSON.stringify(fine.body)}`);
  // Under a cap the gateway's model has no price: a model blocker. Not held, the run check refuses it, as before.
  const unheld = await api("POST", "/agents/gw/runs", { input, max_cost_usd: 1 });
  assert.deepEqual([unheld.status, unheld.body.error?.code], [409, "agent_not_runnable"], `the cap's unpriced model refuses a run that is not held: ${JSON.stringify(unheld.body)}`);
  assert.match(unheld.body.error.message, /has no price here/, "the refusal is the model's");
  // Held, that refusal is deferred and the launch pins no model; its revision's model still keys it: 422, as above.
  const refused = await api("POST", "/agents/gw/runs", { input, hold: true, max_cost_usd: 1 });
  assert.deepEqual([refused.status, refused.body.error?.code], [422, "model_key_required"], `a held run whose model was refused at its create is still refused 422 model_key_required on a gateway with no key: ${JSON.stringify(refused.body)}`);
  assert.deepEqual(wordsOf(refused.body.error), wordsOf(fine.body.error), "in the same words and fields any run there gets");
  assert.deepEqual((await api("GET", "/agents/gw/runs")).body.runs, [], "no run was made");
  assert.equal(seam.count.opened, 0, "no computer was opened for it");

  // Handed a model key, the same held run opens: the key fits the gateway its revision's model goes to. A message to it,
  // with a key too, is refused in its create's words, never first for the key (its launch pins no model to check it on).
  const keyed = await api("POST", "/agents/gw/runs", { input, hold: true, max_cost_usd: 1, model_key: GATEWAY_KEY });
  assert.equal(keyed.status, 202, `a held run handed a key for the gateway opens: ${JSON.stringify(keyed.body)}`);
  await seam.claimed;
  // The claim asked for its computer; the owner's call goes through its runner, so its answer comes once the hold is up.
  const call = await api("POST", `/runs/${keyed.body.run_id}/computer/call`, { method: "files.list", params: { path: "/workspace" } });
  await withRunRead(api, keyed.body.run_id, () => assert.deepEqual([call.status, call.body.ok], [200, true], `the owner's call reaches the held computer: ${JSON.stringify(call.body)}`));
  const sent = await api("POST", `/runs/${keyed.body.run_id}/messages`, { content: "Go on.", model_key: GATEWAY_KEY });
  await withRunRead(api, keyed.body.run_id, () => {
    assert.deepEqual([sent.status, sent.body.error?.code], [409, "agent_not_runnable"], `a message with a key to a held run whose model was refused is refused as its start is: ${JSON.stringify(sent.body)}`);
    assert.equal(sent.body.error.message, unheld.body.error.message, "in the words its create would have given");
  });
  const release = await api("POST", `/runs/${keyed.body.run_id}/computer/release`, {});
  await withRunRead(api, keyed.body.run_id, () => assert.deepEqual([release.status, release.body], [200, { held: { state: "released" } }], `its release lets the computer go: ${JSON.stringify(release.body)}`));
  await seam.released;
});

test("a message to a held run its model kept from running is refused in its create's words, whatever the run's state, a trigger's too, and nothing is sent or opened again", async () => {
  const body = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, hold: { minutes: 5, refused: REFUSAL } };
  // The store holds the launch alone: a steer's row or a reopen would reach for more and fail on another error.
  const store = { runners: { live: async () => [] }, runs: { launch: async () => ({ body }) } };
  const moment = (extra = {}) => ({ id: "run-1", agentId: "agent-1", kind: "agentic", harness: "pi", cancelled: false, terminal: false, working: false, awaitingAnswer: false, steers: true, paused: false, ...extra });
  const refused = (error) => error instanceof ApiError && error.code === "agent_not_runnable" && error.message === REFUSAL.message && JSON.stringify(error.extra?.fields) === JSON.stringify(REFUSAL.fields);
  await assert.rejects(message(store, moment(), "Go on."), refused, "while it waits for its start: a message would be its first turn");
  await assert.rejects(message(store, moment({ terminal: true, terminalKind: "completed" }), "Go on."), refused, "once it ended: a message would open it again (steerOrReopen)");
  await assert.rejects(message(store, moment(), "Go on.", { answers: false, queue: async () => assert.fail("a trigger's steer is never queued") }), refused, "a trigger's message_run (trigger-targets.ts), through the same message()");
});

test("a grade's feedback round never opens a held run its model kept from running", async () => {
  const of = (hold) => {
    const reopened = [];
    const body = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, learning: { seed: null, section: "" }, hold };
    const store = {
      runs: {
        get: async () => ({ id: "run-1", agentId: "agent-1", archivedAt: null, state: "stopped", outcome: "stopped", summary: null, endedAt: 1_000 }),
        launch: async () => ({ body }),
        reopen: async (id) => (reopened.push(id), { id: 7 }),
      },
      agents: { get: async () => ({ archivedAt: null }) },
    };
    return { store, reopened };
  };
  const grade = { run: "run-1", correct: false, source: "feedback", at: "2026-11-24T00:00:00Z", path: "agent" };
  const control = of({ minutes: 5 });
  assert.deepEqual(await openFeedbackRound(control.store, grade, "Wrong answer."), { round: "correction", command: 7 }, "a held run that ran opens on its grade's round");
  assert.deepEqual(control.reopened, ["run-1"], "the control's round reopened it");
  const refused = of({ minutes: 5, refused: REFUSAL });
  assert.equal(await openFeedbackRound(refused.store, grade, "Wrong answer."), null, "one its model kept from running opens no round");
  assert.deepEqual(refused.reopened, [], "and is never opened again");
});

test("pi (adapter-run-spec), no model key here: a claim of a run whose hold carries no refusal chooses its model as before and fails in the create's words; a held run its model kept from running chooses none, and its claim holds the computer", async (t) => {
  withEnv(t, {}, KEYLESS);
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-spec-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let routed = 0;
  // The runner's own route (model-route.ts routeOf), counted: on this host it fails in chooseModel's why, the create's.
  const counted = async (...args) => {
    routed += 1;
    return routeOf(...args);
  };
  const phone = phoneOn(root);
  // The revision's model, unpinned (the launch pins none), as the create read it.
  const body = { model: MODEL, computer: PHONE };
  const failsInKeyWords = (error) => (assert.match(error.message, KEY_WORDS, `the claim fails in the key's words: ${error.message}`), true);
  await assert.rejects(specFor(t, { body, launch: { model: undefined }, routeOf: counted, computer: phone }), failsInKeyWords, "a run that is not held chooses its model at its claim, and fails with no key for it");
  await assert.rejects(specFor(t, { body, launch: { model: undefined, hold: { minutes: 5 } }, routeOf: counted, computer: phone }), failsInKeyWords, "so does a held run whose hold carries no refusal: only the deferred refusal takes the stand-in");
  assert.equal(routed, 2, "each of those claims asked for its model's route");
  const { spec } = await specFor(t, { body, launch: { model: undefined, hold: { minutes: 5, refused: REFUSAL } }, routeOf: counted, computer: phone }).catch((error) => assert.fail(`a held run its model kept from running opens its claim with no key here: ${error.message}`));
  assert.equal(routed, 2, "the held claim never asked for its model's route: no model is chosen and no key is read");
  assert.deepEqual(spec.held, { minutes: 5 }, "the spec holds the computer for its owner");
});

test("pi (adapter-run-spec), subagent tiers: a held run its model kept from running, granted subagent on a host with a model key and a fast model, routes none of its tiers at its claim", async (t) => {
  withEnv(t, {}, KEYLESS);
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-tiers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let routed = 0;
  // Every route the claim asks for (model-route.ts routeOf), counted: the run's own, a subagent tier's, a learned node's.
  const counted = async (...args) => {
    routed += 1;
    return routeOf(...args);
  };
  // The host's fast model, and a key that reaches it: a claim that routes the tier chooses that model and reads that key.
  const env = { AGENT_MODEL_FAST: "openrouter/anthropic/claude-haiku-5.5", OPENROUTER_API_KEY: HOST_MODEL_KEY };
  const { spec } = await specFor(t, { body: { model: MODEL, computer: PHONE, tools: ["subagent"] }, launch: { model: undefined, hold: { minutes: 5, refused: REFUSAL } }, env, routeOf: counted, computer: phoneOn(root) })
    .catch((error) => assert.fail(`a held run granted subagent opens its claim: ${error.message}`));
  assert.equal(routed, 0, "the held claim routed none of its subagent tiers: no tier's model is chosen, and no saved model key is opened for one");
  assert.deepEqual(spec.held, { minutes: 5 }, "the spec holds the computer for its owner");
});

test("pi (adapter-run-spec), learning steps: a held run its model kept from running takes none at its claim, so a replay's claim check never runs", async (t) => {
  withEnv(t, {}, KEYLESS);
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-learned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // learnedFirst's steps (runner/learned-first.ts: audits settled, the promotion gate, a replay's claim check) start replay
  // runs and read the agent's learning: none is a held run's. The replay check is the one a fake claim shows: it refuses
  // this claim, its workflow never laid, wherever it runs.
  let routed = 0;
  // Every route the claim asks for (model-route.ts routeOf), counted: a replay's grader's (graderRouteOf) and a learned
  // node's tier's among them. The host's fast model, and a key that reaches it: a claim that routes a grader routes that.
  const counted = async (...args) => {
    routed += 1;
    return routeOf(...args);
  };
  const env = { AGENT_MODEL_FAST: "openrouter/anthropic/claude-haiku-5.5", OPENROUTER_API_KEY: HOST_MODEL_KEY };
  const { spec } = await specFor(t, { body: { model: MODEL, computer: PHONE }, launch: { model: undefined, hold: { minutes: 5, refused: REFUSAL }, replay: REPLAY }, env, routeOf: counted, computer: phoneOn(root) })
    .catch((error) => assert.fail(`the held claim took no learning step (a replay's claim check would refuse it): ${error.message}`));
  assert.equal(routed, 0, "the held replay's claim routed no grader and no learned tier: no fast model is chosen for it, and no saved model key is opened for one");
  assert.deepEqual(spec.held, { minutes: 5 }, "the spec holds the computer for its owner");
});

test("claim secrets (claimSecrets): a held run its model kept from running is laid its tools' keys and no model key; the same run not held is laid its model's key too", async () => {
  // The host holds both where AgentRun starts; no store is read (no seal key).
  const deps = { store: { sealedKeys: { get: async () => undefined }, settings: { get: async () => undefined } }, env: { OPENROUTER_API_KEY: HOST_MODEL_KEY, PARALLEL_API_KEY: HOST_TOOL_KEY } };
  const revision = { kind: "agentic", body: { model: MODEL, tools: ["web_search"] } };
  const plane = { web_search: "parallel", web_fetch: "parallel" };
  const unheld = await claimSecrets(deps, revision, { plane });
  assert.deepEqual([unheld.OPENROUTER_API_KEY, unheld.PARALLEL_API_KEY], [HOST_MODEL_KEY, HOST_TOOL_KEY], "a claim of the run, not held, is laid its revision's model's key and its tool's key");
  const held = await claimSecrets(deps, revision, { plane, hold: { minutes: 5, refused: REFUSAL } });
  assert.equal(held.OPENROUTER_API_KEY, undefined, "a held run its model kept from running is laid no model key: its model runs nowhere");
  assert.equal(held.PARALLEL_API_KEY, HOST_TOOL_KEY, "its tool's key is laid as any claim's is");
});

/** A gateway's key saved in the console (model-gateway.ts saveGateway), a test's: never a real one. */
const SAVED_GATEWAY_KEY = "not-a-secret-held-saved-gateway-key";
/** A run's process as a test's stand-in: it writes the names of the keys its runner handed it on fd 3 (secrets.ts
 *  encode: NAME=VALUE, each ended by a NUL), never a value, to the file its argument names, and exits. */
const NAMES_OF_KEYS = `import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
const chunks = [];
const pipe = new Socket({ fd: 3, readable: true, writable: false });
pipe.on("data", (chunk) => chunks.push(chunk));
pipe.on("error", () => process.exit(1));
pipe.on("end", () => {
  const names = Buffer.concat(chunks).toString("utf8").split("\\0").filter(Boolean).map((pair) => pair.slice(0, pair.indexOf("=")));
  writeFileSync(process.argv[2], JSON.stringify(names));
  process.exit(0);
});
`;

/** The names of the keys a runner that starts each claim in a process of its own (run-child-host.ts childLoops) hands a
 *  pi run of MODEL on its process's key pipe, read by the stand-in above, which exits once it wrote them (so the claim
 *  ends failed: its process ended before its loop did). `env`: the runner's; `hold`: the launch's; `before`: what the
 *  server saved first (a model gateway). */
async function handedNames(t, { env = {}, hold, before } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-child-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await before?.(store);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", model: MODEL, tools: [] } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: "pi", ...(hold ? { hold } : {}) }) });
  const script = join(dir, "names-of-keys.mjs");
  const out = join(dir, "names.json");
  await writeFile(script, NAMES_OF_KEYS);
  const deps = { store, data: dir, sealKey: SEAL_KEY, env, computerForClaim: async () => assert.fail("the run names no computer") };
  const loop = childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: () => {}, argv: [process.execPath, script, out] })({
    signal: new AbortController().signal, journal: (claim) => store.journal(claim), flush: async () => {}, delivered: Promise.resolve(),
  });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const ended = await loop.start(claim).then(() => undefined, (error) => error);
  const written = await readFile(out, "utf8").catch(() => assert.fail(`the run's process was started and wrote the names of its keys: ${ended?.message ?? "its claim ended"}`));
  return JSON.parse(written);
}

/** A gateway saved in the console with its key (model-gateway.ts saveGateway), as the server saves it. */
const saveAGateway = (store) => saveGateway({ store, sealKey: SEAL_KEY, env: {}, changed: async () => {} }, { base_url: "https://a.example/v1", api_key: SAVED_GATEWAY_KEY, models: { default: "m-1" } });

test("per-run process (run-child-host), a host with a model key: a held run its model kept from running is handed no model key on its process's key pipe; the same run not held is handed its model's key", async (t) => {
  withEnv(t, {}, KEYLESS);
  const env = { OPENROUTER_API_KEY: HOST_MODEL_KEY };
  const unheld = await handedNames(t, { env });
  assert.ok(unheld.includes("OPENROUTER_API_KEY"), `the run not held is handed its model's key, as before: ${JSON.stringify(unheld)}`);
  const held = await handedNames(t, { env, hold: { minutes: 5, refused: REFUSAL } });
  assert.ok(!held.includes(GATEWAY_KEY_ENV), `a held run its model kept from running is handed no gateway key: ${JSON.stringify(held)}`);
  assert.deepEqual(held.filter((name) => MODEL_KEY_NAMES.includes(name)), [], "a held run its model kept from running is handed no model key on a host that holds one: its model runs nowhere");
});

test("per-run process (run-child-host), a host with a model key and a saved gateway: a held run its model kept from running is handed neither the gateway's key nor any model key; the same run not held is handed the gateway's key", async (t) => {
  withEnv(t, {}, KEYLESS);
  const env = { OPENROUTER_API_KEY: HOST_MODEL_KEY };
  const unheld = await handedNames(t, { env, before: saveAGateway });
  assert.ok(unheld.includes(GATEWAY_KEY_ENV), `the run not held is handed the saved gateway's key for its model routes, as before: ${JSON.stringify(unheld)}`);
  const held = await handedNames(t, { env, hold: { minutes: 5, refused: REFUSAL }, before: saveAGateway });
  assert.ok(!held.includes(GATEWAY_KEY_ENV), `a held run its model kept from running is handed no saved gateway key: ${JSON.stringify(held)}`);
  assert.deepEqual(held.filter((name) => MODEL_KEY_NAMES.includes(name)), [], "and no model key of the host's: its model runs nowhere");
});

/** The words the runner refuses a held run's process's ask for a learning step in (run-child-host.ts heldFor). */
const HELD_SPEND_WORDS = /a held run its model kept from running asks its runner for no model spend/;

test("per-run process (run-child-host heldFor): the runner answers a held run its model kept from running no saved model key, no tier's key, keyless with no key read, and no learning step, whatever its process asks; the same run not held, granted subagent, is answered the host's model key", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-seam-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // A run granted subagent whose fast tier runs on OpenRouter: its process asks the runner for its tiers' saved model keys.
  const revision = { kind: "agentic", body: { instructions: "Answer.", model: MODEL, tools: ["subagent"], modelTiers: { fast: "openrouter/anthropic/claude-haiku-5.5" } } };
  const seam = (launch) => heldFor({ store, sealKey: SEAL_KEY, env: { OPENROUTER_API_KEY: HOST_MODEL_KEY }, data: dir }, { claim: { runId: "run-1", epoch: 1 }, run: { agentId: "agent-1", revisionId: "rev-1", signInHanded: null }, launch, revision, claimed: {} }, (text) => text, () => {}).held;
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: "pi" };
  assert.equal((await seam(launch).subagentTierKeys()).OPENROUTER_API_KEY, HOST_MODEL_KEY, "a run not held, granted subagent, is answered the host's model key for its fast tier");
  const held = seam({ ...launch, hold: { minutes: 5, refused: REFUSAL } });
  assert.deepEqual(await held.subagentTierKeys(), {}, "a held run its model kept from running is answered no saved model key, though its process asks: its model runs nowhere");
  // A replay grades on its fast tier's model, whose provider's saved key its runner hands its process: not a held one's.
  const graded = { kind: "agentic", body: { instructions: "Answer.", model: MODEL, modelTiers: { fast: "openrouter/anthropic/claude-haiku-5.5" } } };
  const replaySeam = (hold) => heldFor({ store, sealKey: SEAL_KEY, env: { OPENROUTER_API_KEY: HOST_MODEL_KEY }, data: dir }, { claim: { runId: "run-2", epoch: 1 }, run: { agentId: "agent-1", revisionId: "rev-2", signInHanded: null }, launch: { ...launch, replay: { of: "run-asked", workflow: "answer", digest: "d".repeat(16) }, ...hold }, revision: graded, claimed: {} }, (text) => text, () => {}).held;
  assert.deepEqual(await replaySeam({}).subagentTierKeys(), { OPENROUTER_API_KEY: HOST_MODEL_KEY }, "a replay not held is answered its grader's provider's saved key, as before");
  assert.deepEqual(await replaySeam({ hold: { minutes: 5, refused: REFUSAL } }).subagentTierKeys(), {}, "a held replay its model kept from running is answered no grader's key either: it grades nothing");
  // Its learnedFirst is refused below, so it lays no learned workflow whose tiers it could ask for: this answer is that
  // refusal's as much as tierModelKeys' own.
  assert.deepEqual((await held.tierModelKeys(["fast", "strong"])).keys, {}, "and no tier's key: none is chosen, its learned workflows refused");
  assert.equal(await held.serverKeyless(), true, "its keyless check answers that no key of the server's pays for its spend, with no saved key read (this host has no gateway, so a read would answer false)");
  await assert.rejects(held.learnedFirst({ laid: false }), HELD_SPEND_WORDS, "nor a learning step: it settles no audit and starts no replay run");
  // The same held run, learning: its end-of-run step would compile a draft over the server's decision keys and could start
  // an audit on the server's key (claimSpendOff), were it asked.
  const learning = seam({ ...launch, hold: { minutes: 5, refused: REFUSAL }, learning: { seed: "0".repeat(40), section: "" } });
  const ended = { runId: "run-1", agentId: "agent-1", claim: { runId: "run-1", epoch: 1 }, outcome: "completed", ask: async () => assert.fail("a held run's end-of-run step asks nothing"), signal: new AbortController().signal };
  await assert.rejects(learning.endOfRun(ended), HELD_SPEND_WORDS, "nor its end-of-run step, though it learns: it reads no saved key, compiles nothing and starts no audit");
  // The control: the same learning run not held is not refused in those words. Its step runs as any claim's, against a test
  // store with no seed, so how it ends here (an answer, or a failure of its own) is not this test's; only the refusal is.
  const unheldEnd = await seam({ ...launch, learning: { seed: "0".repeat(40), section: "" } }).endOfRun({ ...ended, ask: async () => Promise.reject(new Error("the control's step asked its model")) })
    .then(() => "answered", (error) => error.message);
  assert.doesNotMatch(unheldEnd, HELD_SPEND_WORDS, "the same learning run not held is not refused its end-of-run step: only a held run its model kept from running is");
  // And held, its hold carrying no refusal (its model fine): the refusal is the hold's refusal's, never the hold's.
  const heldFineEnd = await seam({ ...launch, hold: { minutes: 5 }, learning: { seed: "0".repeat(40), section: "" } }).endOfRun({ ...ended, ask: async () => Promise.reject(new Error("the control's step asked its model")) })
    .then(() => "answered", (error) => error.message);
  assert.doesNotMatch(heldFineEnd, HELD_SPEND_WORDS, "a held learning run whose hold carries no refusal is not refused its end-of-run step either: only one its model kept from running is");
});

/** A learning start, as a learning run's launch carries it (run-launch.ts learningStartOf). */
const LEARNS = { seed: "0".repeat(40), section: "" };

test("pi (adapter-run-spec), end of run: a held run its model kept from running that learns carries no end-of-run step; the same run not held carries one", async (t) => {
  withEnv(t, {}, KEYLESS);
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-end-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = { model: MODEL, computer: PHONE, learning: true };
  // The control's route is specFor's stub: no key is needed for a claim that is not held to open.
  const { spec: unheld } = await specFor(t, { body, launch: { model: undefined, learning: LEARNS }, computer: phoneOn(root) });
  assert.equal(typeof unheld.endOfRun, "function", "the run not held, learning, carries its end-of-run step, as before");
  const { spec } = await specFor(t, { body, launch: { model: undefined, hold: { minutes: 5, refused: REFUSAL }, learning: LEARNS }, computer: phoneOn(root) })
    .catch((error) => assert.fail(`a held learning run its model kept from running opens its claim: ${error.message}`));
  assert.equal(spec.endOfRun, null, "a held run its model kept from running carries no end-of-run step, though it learns, and says none (null), so the loop asks none of its own: its model runs nowhere, so nothing is compiled and no audit starts");
});

test("CLI (cli-run-spec), end of run: a held opencode run its model kept from running that learns carries no end-of-run step; the same run not held carries one", async (t) => {
  withEnv(t, {}, KEYLESS);
  // The control's host holds opencode's key (the test's host model key), so the claim that is not held opens.
  const unheld = await cliClaim(t, undefined, { learning: LEARNS }, { env: { OPENAI_API_KEY: HOST_MODEL_KEY } });
  assert.equal(typeof unheld.endOfRun, "function", "the run not held, learning, carries its end-of-run step, as before");
  const spec = await cliClaim(t, { minutes: 5, refused: REFUSAL }, { learning: LEARNS }).catch((error) => assert.fail(`a held learning opencode run opens its claim: ${error.message}`));
  assert.equal(spec.endOfRun, null, "a held run its model kept from running carries no end-of-run step, though it learns, and says none (null)");
});

test("pi: the stand-in route refuses every model request in the create's words, verbatim, and sends none", async (t) => {
  const route = heldRefusedRoute({ provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }, REFUSAL.message);
  refusedIn(await askThrough(t, route.provider), REFUSAL.message, "pi, a first request");
  refusedIn(await askThrough(t, route.provider), REFUSAL.message, "pi, a second request");
});

test("CLI (cli-run-spec), no model key here: a claim of an opencode run that is not held fails in its model's words; one whose hold carries no refusal too; a held run its model kept from running chooses none, and its claim opens", async (t) => {
  withEnv(t, {}, KEYLESS);
  let said;
  await assert.rejects(cliClaim(t, undefined), (error) => {
    said = error.message;
    assert.match(said, /OPENAI_API_KEY/, `the claim names the key it lacks: ${said}`);
    return true;
  }, "a run that is not held chooses its model at its claim, as before, and fails with no key for it");
  await assert.rejects(cliClaim(t, { minutes: 5 }), { message: said }, "a held run whose hold carries no refusal chooses it at its claim too, and fails in the same words");
  const spec = await cliClaim(t, { minutes: 5, refused: { ...REFUSAL, message: said } }).catch((error) => assert.fail(`a held run its model kept from running opens its claim with no key here: ${error.message}`));
  assert.ok(spec.adapter, "its spec carries opencode's adapter, on the stand-in");
});

test("CLI (cli-run-spec), learning steps: a held opencode run its model kept from running takes none at its claim, so a replay's claim check never runs", async (t) => {
  withEnv(t, {}, KEYLESS);
  // As on pi: learnedFirst's replay check would refuse this claim, its workflow never laid, wherever it runs.
  let routed = 0;
  // The runner's model route (model-route.ts routeOf), counted: a CLI run's own model never takes it, and a replay's grader
  // (graderRouteOf) does. The host's fast model, and a key that reaches it: a claim that routes a grader routes that.
  const counted = async (...args) => {
    routed += 1;
    return routeOf(...args);
  };
  const env = { AGENT_MODEL_FAST: "openrouter/anthropic/claude-haiku-5.5", OPENROUTER_API_KEY: HOST_MODEL_KEY };
  const spec = await cliClaim(t, { minutes: 5, refused: REFUSAL }, { replay: REPLAY }, { env, routeOf: counted }).catch((error) => assert.fail(`the held claim took no learning step (a replay's claim check would refuse it): ${error.message}`));
  assert.equal(routed, 0, "the held replay's claim routed no grader: no fast model is chosen for it, and no saved model key is opened for one");
  assert.ok(spec.adapter, "its spec carries opencode's adapter, on the stand-in");
});

test("CLI harnesses: the adapter of a held run its model kept from running (claude-agent, codex, opencode) is built with no key here, and its provider refuses every model request in the create's words, verbatim, and sends none", async (t) => {
  withEnv(t, {}, KEYLESS);
  const needs = (model) => ({ model, models: { getModel: () => undefined }, heldRefusal: REFUSAL.message });
  const given = new Map();
  const standIn = JSON.stringify({ command: process.execPath, args: [] });
  const built = (who) => (error) => assert.fail(`${who}'s adapter of a held run is built with no key here: ${error.message}`);
  await opencodeOf({ [OPENCODE_STANDIN_ENV]: standIn }, needs({ provider: "openai", modelId: "gpt-6.1-sol" }), async () => ({ openCodeAdapter: (options) => (given.set("opencode", options.provider), { id: "opencode" }) })).catch(built("opencode"));
  await codexOf({ [CODEX_STANDIN_ENV]: standIn }, needs({ provider: "openai", modelId: "gpt-6.1-sol" }), async () => ({ codexAdapter: (options) => (given.set("codex", options.provider), { id: "codex" }) })).catch(built("codex"));
  const real = await import("@parcha/agentrun-harness-claude");
  const claude = async () => ({ ...real, verifyClaudeAgentCliAsync: async () => {}, claudeAgentAdapter: (options) => (given.set("claude-agent", options.provider), { id: "claude-agent" }) });
  await claudeOf({}, needs({ provider: "anthropic", modelId: "claude-sonnet-5-5" }), claude, loadedSdk).catch(built("claude-agent"));
  assert.deepEqual([...given.keys()].sort(), ["claude-agent", "codex", "opencode"], "each adapter was handed a provider");
  for (const [who, provider] of given) refusedIn(await askThrough(t, provider), REFUSAL.message, who);
});

test("a held claim that can never start lets its computer go once no call came for its minutes, on the hold's own clock", async () => {
  const written = [];
  let clock = 1_000;
  const minutes = 0.01; // 600 ms of the hold's clock: no time passes for real.
  const held = journalHeld({ minutes }, async (entries) => void written.push(...entries), () => clock);
  assert.equal(await held.up([]), "held", "the first pass writes the hold waiting");
  // The owner's calls keep it: each starts the count again.
  for (const at of [1_300, 1_700]) {
    clock = at;
    written.push({ kind: CALL_KIND, data: { by: at, at, method: "files.list", ok: true, ms: 1 } });
    held.touched(at);
  }
  assert.equal(heldIn(written).until, 1_700 + minutes * 60_000, "the lapse is read from the last call");
  // No start comes (the server refuses it), and no call after the last: the hold lapses minutes after it.
  clock = 1_700 + minutes * 60_000 + 1;
  assert.equal(await held.untilStarted(new Promise(() => {})), "moved", "the wait ends with no start");
  assert.deepEqual([held.state(), held.lapse()], ["released", "timeout"], "the computer was let go by the hold's timeout");
  assert.deepEqual(heldIn(written), { state: "released", minutes, until: clock + minutes * 60_000, why: "timeout" }, "the run's journal says so");
  assert.match(held.refusesCall(), /let go: no call came/, "and a later call is refused");
});
