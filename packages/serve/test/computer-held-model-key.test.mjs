// A held run (computer-held.ts) whose model can't run here: no key for it, its harness refusing it, no price under a cap.
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
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MODEL_KEYS } from "../dist/model.js";
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
const { claudeOf, codexOf, opencodeOf, CODEX_STANDIN_ENV, OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { openSqliteStore } = await import("../dist/store/index.js");
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

/** The runner's claim-time computer (computerForClaim): the fake computer on `root` as a sandbox, with an event once a
 *  claim asked for it and once it was let go, and the computers it opened (`opened`), counted. */
function claimSeam(root) {
  const box = fakeComputer(root);
  let claim;
  let release;
  const claimed = new Promise((resolve) => (claim = resolve));
  const released = new Promise((resolve) => (release = resolve));
  const count = { opened: 0 };
  const computerForClaim = async () => {
    count.opened += 1;
    claim();
    return { computer: { kind: "sandbox", computer: box, hello: HELLO }, release: async () => release() };
  };
  return { box, claimed, released, computerForClaim, count };
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
 *  runner place). `hold`: the launch's. Resolves to the spec; rejects as the claim fails. */
async function cliClaim(t, hold) {
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
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: "opencode", ...(hold ? { hold } : {}) };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const env = { [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [] }), PATH: process.env.PATH };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  built = await cliRunSpecFromLaunch(launch, { harness, registry, setModels: (given) => (models = given) }, deps, claim);
  return built;
}

test("served, no model key: a held run opens and holds its computer, its start and messages are refused in the create's own words, and its release lets the computer go", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seam = claimSeam(root);
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
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const held = await api("POST", "/agents/searcher/runs", { input: { content: "Find it." }, hold: true });
  assert.deepEqual([held.status, held.body.error?.code], [409, "agent_not_runnable"], `a hold defers the model's refusal only: ${JSON.stringify(held.body)}`);
  assert.deepEqual(held.body.error.details?.missing?.web_search, ["PARALLEL_API_KEY"], "the tool's missing key still refuses the held create");
  assert.deepEqual((await api("GET", "/agents/searcher/runs")).body.runs, [], "no run was made");
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
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-model-key-gw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seam = claimSeam(root);
  // A gateway on loopback that nothing listens on: nothing here asks it. No price is set, so its model has none.
  withEnv(t, {}, ["AGENT_MODEL_PRICE"]);
  const { api } = await keylessServer(t, seam, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" });
  assert.equal((await api("POST", "/agents", agent("gw", { model: "agent-model/not-a-catalog-model", computer: SANDBOX }))).status, 201);
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
  const sent = await api("POST", `/runs/${keyed.body.run_id}/messages`, { content: "Go on.", model_key: GATEWAY_KEY });
  assert.deepEqual([sent.status, sent.body.error?.code], [409, "agent_not_runnable"], `a message with a key to a held run whose model was refused is refused as its start is: ${JSON.stringify(sent.body)}`);
  assert.equal(sent.body.error.message, unheld.body.error.message, "in the words its create would have given");
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
  assert.deepEqual(control.reopened, ["run-1"]);
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
  const phone = () => ({ computerForClaim: async () => ({ computer: { kind: "phone", computer: fakeComputer(root), hello: { ...HELLO, os: "android", kind: "android" } }, release: async () => {} }) });
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
  assert.equal(await held.up([]), "held");
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
