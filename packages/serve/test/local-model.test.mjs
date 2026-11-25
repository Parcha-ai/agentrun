// A free local model on the owner's own machine (local-model.ts): the machine's facts, the model recommended for them (a
// pure function, tested as a table), and one pull at a time through the Ollama here, its progress on the read surface,
// the model in the picker the moment it ends. The machine is handed in (ServeOptions.machine) and the Ollama is a fake on
// loopback (fixtures/fake-ollama.mjs): no test reads this box's hardware or asks its Ollama.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";
import { serve, withEnv } from "./support.mjs";

const { INKLING, INKLING_OLLAMA, LOCAL_MODEL_TAGS, OLLAMA_DOWNLOAD, QWEN3_DEFAULT, RAM_FLOOR_GIB, nvidiaOf, pullRefusal, recommendLocalModel, versionAtLeast } = await import("../dist/local-model.js");
const { ollamaClock } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs, OLLAMA_OFF_ENV); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

const GIB = 1024 ** 3;
const APPLE = (gib) => ({ platform: "darwin", arch: "arm64", ram_bytes: Math.round(gib * GIB), gpu: { kind: "apple", unified: true } });
const LINUX = (gib) => ({ platform: "linux", arch: "x64", ram_bytes: Math.round(gib * GIB), gpu: { kind: "unknown" } });
const NVIDIA = (gib) => ({ platform: "linux", arch: "x64", ram_bytes: Math.round(gib * GIB), gpu: { kind: "nvidia", name: "Synth GPU 24", memory_bytes: 24 * GIB } });
const WINDOWS = (gib) => ({ platform: "win32", arch: "x64", ram_bytes: Math.round(gib * GIB), gpu: { kind: "unknown" } });
const UP = (version = INKLING_OLLAMA) => ({ asked: true, reachable: true, version });
const DOWN = { asked: true, reachable: false, version: null };
const NOT_ASKED = { asked: false, reachable: false, version: null };
const facts = (machine, ollama = UP(), pulled = []) => ({ machine, ollama, pulled });

test("the recommendation over the machine's facts: Apple silicon on a new Ollama gets Inkling; everyone else the qwen3 default, a smaller one, or none, in words", () => {
  const rows = [
    // [what, facts, tag, pulled, why must match, why must not match]
    ["Apple silicon, Ollama 0.40.17", facts(APPLE(32)), INKLING, false, new RegExp(`Apple silicon with Ollama ${INKLING_OLLAMA} runs ${INKLING}`)],
    ["Apple silicon, a later Ollama", facts(APPLE(32), UP("0.41.2")), INKLING, false, /runs inkling-2-mini/],
    ["Apple silicon, Ollama 0.40.16", facts(APPLE(32), UP("0.40.16")), QWEN3_DEFAULT, false, /Update Ollama to 0\.40\.17 for inkling-2-mini\./],
    ["Apple silicon, Ollama 0.9.99", facts(APPLE(32), UP("0.9.99")), QWEN3_DEFAULT, false, /Update Ollama to 0\.40\.17 for inkling-2-mini\./],
    ["Apple silicon, a new Ollama, too little memory for Inkling", facts(APPLE(12)), "qwen3:4b", false, /inkling-2-mini needs 15 GiB of memory, and this Mac has 12\.0 GiB/],
    ["Linux, no GPU", facts(LINUX(32)), QWEN3_DEFAULT, false, /qwen3:8b fits this machine's 32\.0 GiB of memory \(it needs 15 GiB\)\./, /Update Ollama/],
    ["Linux, an NVIDIA GPU", facts(NVIDIA(64)), QWEN3_DEFAULT, false, /fits this machine's 64\.0 GiB/, /Update Ollama/],
    ["Windows, a 16 GB machine", facts(WINDOWS(15.6)), QWEN3_DEFAULT, false, /15\.6 GiB/],
    ["Linux, low memory: the smaller qwen3", facts(LINUX(12)), "qwen3:4b", false, /qwen3:8b needs 15 GiB of memory, so the smaller qwen3:4b/],
    ["Linux, too little memory for any", facts(LINUX(8)), null, false, /This machine has 8\.0 GiB of memory, and the smallest local model offered here, qwen3:4b needs 11 GiB of memory\. Add a model key instead\./],
    ["no Ollama", facts(LINUX(32), DOWN), null, false, new RegExp(`Install it from ${OLLAMA_DOWNLOAD.replace(/[.]/g, "\\.")}`)],
    ["no Ollama on a Mac", facts(APPLE(32), DOWN), null, false, /Ollama isn't running/],
    ["Ollama not asked (the faux model or a gateway)", facts(APPLE(32), NOT_ASKED, [QWEN3_DEFAULT]), null, false, /asks no Ollama/, /isn't running|Install it/],
    ["already pulled", facts(LINUX(32), UP(), ["synth-plain:1b", QWEN3_DEFAULT]), QWEN3_DEFAULT, true, /Already pulled: no pull needed\./],
    ["Inkling already pulled, as Ollama lists it (:latest)", facts(APPLE(32), UP(), [`${INKLING}:latest`]), INKLING, true, /Already pulled/],
  ];
  for (const [what, given, tag, pulled, said, unsaid] of rows) {
    const got = recommendLocalModel(given);
    assert.equal(got.tag, tag, `${what}: ${JSON.stringify(got)}`);
    assert.equal(got.pulled, pulled, what);
    assert.match(got.why, said, what);
    if (unsaid) assert.doesNotMatch(got.why, unsaid, what);
    if (got.tag !== null) assert.ok(LOCAL_MODEL_TAGS.includes(got.tag), `${what}: ${got.tag} is one a pull takes`);
  }
});

test("the tags a pull takes are exactly the ones the recommendation names, each with its memory floor", () => {
  assert.deepEqual([...LOCAL_MODEL_TAGS], [INKLING, QWEN3_DEFAULT, "qwen3:4b"]);
  for (const tag of LOCAL_MODEL_TAGS) assert.equal(typeof RAM_FLOOR_GIB[tag], "number", tag);
});

test("Ollama's version against the floor: numbers, not text; a suffix ignored; an unreadable one is not past it", () => {
  for (const [version, past] of [["0.40.17", true], ["0.40.18", true], ["0.41.0", true], ["1.0.0", true], ["0.40.17-rc1", true], ["0.40.16", false], ["0.4.170", false], ["0.39.99", false], ["0.0.0", false], ["dev", false], ["", false]]) {
    assert.equal(versionAtLeast(version, INKLING_OLLAMA), past, version);
  }
});

test("nvidia-smi's first line is the GPU; anything else is unknown", () => {
  assert.deepEqual(nvidiaOf("Synth GPU 24, 24564\nSynth GPU 8, 8192\n"), { kind: "nvidia", name: "Synth GPU 24", memory_bytes: 24564 * 1024 ** 2 });
  for (const out of [undefined, "", "No devices were found", "Synth, lots"]) assert.deepEqual(nvidiaOf(out), { kind: "unknown" }, String(out));
});

test("no pull under the faux model or a model gateway, nor on a server that is not one owner's own", () => {
  assert.match(pullRefusal({ AGENTRUN_SERVE_FAUX: "/x", OLLAMA_HOST: "127.0.0.1:1" }, []), /faux model/);
  assert.match(pullRefusal({ AGENT_MODEL_BASE_URL: "https://gateway.example.test/v1", OLLAMA_HOST: "127.0.0.1:1" }, []), /model gateway \(AGENT_MODEL_BASE_URL\)/);
  assert.match(pullRefusal({ OLLAMA_HOST: "127.0.0.1:1" }, ["runs no runner beside it (--no-runner)"]), /one owner's own server on their own machine, and this server runs no runner beside it/);
  assert.equal(pullRefusal({ OLLAMA_HOST: "127.0.0.1:1" }, []), undefined);
});

/** What makes a test's server one owner's own (server.ts whyNotOwnMachine) unset, and every model key with them. */
const OWNER = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST", "AGENTRUN_RUN_USER", "AGENTRUN_STORE_URL"];
/** The model a pull of QWEN3_DEFAULT adds to the fake: synthetic, as /api/show reports it. */
const PULLED = { name: QWEN3_DEFAULT, capabilities: ["completion", "tools"], family: "synthqwen", context_length: 40_960 };
const piModels = async (api) => (await api("GET", "/capabilities")).body.harnesses.find((harness) => harness.id === "pi").models;

/** Waits until `done()` holds, 10 s at most: a guard against a hang, never a timing assertion. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("one owner's own server: the machine and the qwen3 pick read, a pull of an allowlisted tag alone, its progress, one at a time, logged, and the model in the picker the moment it ends", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  // The kept listing never goes stale here: only the pull's drop of it can show the new model.
  ollamaClock(() => 1_000_000);
  t.after(() => ollamaClock());
  let release;
  const pullHold = new Promise((resolve) => (release = resolve));
  const ollama = await fakeOllama(t, { models: [], pullable: { [QWEN3_DEFAULT]: PULLED }, pullHold });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const lines = [];
  const machine = LINUX(32);
  const server = await serve(t, { faux: undefined, runner: false, machine: async () => machine, log: (line) => lines.push(line) });
  const { api } = server;

  assert.ok(!(await piModels(api)).includes(`ollama/${QWEN3_DEFAULT}`), "not pulled yet");
  const before = await api("GET", "/settings/local-model");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.machine, machine);
  assert.deepEqual(before.body.ollama, { asked: true, reachable: true, version: INKLING_OLLAMA });
  assert.equal(before.body.recommended.tag, QWEN3_DEFAULT);
  assert.equal(before.body.recommended.pulled, false);
  assert.equal(before.body.pull, null);
  assert.equal(before.body.can_pull, true);
  assert.equal(before.body.refused, null);

  // Owner-only: the API token reads nothing of the machine.
  const byToken = await fetch(`${server.baseUrl}/settings/local-model`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(byToken.status, 403);

  // Only the tags the recommendation names.
  for (const body of [{ tag: "synth-evil:70b" }, { tag: `${QWEN3_DEFAULT}-cloud` }, { tag: QWEN3_DEFAULT, insecure: true }, {}]) {
    const refused = await api("POST", "/settings/local-model/pull", body);
    assert.equal(refused.status, 422, `${JSON.stringify(body)}: ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual(ollama.got.pull, [], "no refused tag reached Ollama");

  const started = await api("POST", "/settings/local-model/pull", { tag: QWEN3_DEFAULT });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.pull.tag, QWEN3_DEFAULT);
  assert.equal(started.body.pull.state, "pulling");

  // Its progress on the read surface, as Ollama streams it.
  const midway = await until(async () => {
    const pull = (await api("GET", "/settings/local-model")).body.pull;
    return pull?.completed_bytes === 400 ? pull : undefined;
  }, "the pull's first layer at 400 bytes");
  assert.deepEqual({ state: midway.state, total: midway.total_bytes }, { state: "pulling", total: 1_000 });
  assert.match(midway.status, /^pulling /);

  // One at a time.
  const second = await api("POST", "/settings/local-model/pull", { tag: "qwen3:4b" });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error.code, "local_model_pulling");
  assert.deepEqual(ollama.got.pull, [QWEN3_DEFAULT]);

  release();
  const ended = await until(async () => {
    const pull = (await api("GET", "/settings/local-model")).body.pull;
    return pull?.state !== "pulling" ? pull : undefined;
  }, "the pull's end");
  assert.deepEqual(ended, { tag: QWEN3_DEFAULT, state: "done", status: "success", completed_bytes: 1_000, total_bytes: 1_000 });
  // In the picker at once, and the default: the listing kept before the pull was dropped.
  assert.ok((await piModels(api)).includes(`ollama/${QWEN3_DEFAULT}`), "listed right after the pull");
  assert.equal((await api("GET", "/capabilities")).body.models.default, `ollama/${QWEN3_DEFAULT}`);
  const after = (await api("GET", "/settings/local-model")).body;
  assert.equal(after.recommended.pulled, true);
  assert.match(after.recommended.why, /Already pulled/);

  // A pull Ollama refuses ends failed, in its words; the next may start.
  assert.equal((await api("POST", "/settings/local-model/pull", { tag: "qwen3:4b" })).status, 202);
  const failed = await until(async () => {
    const pull = (await api("GET", "/settings/local-model")).body.pull;
    return pull?.tag === "qwen3:4b" && pull.state !== "pulling" ? pull : undefined;
  }, "the refused pull's end");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "pull model manifest: file does not exist");

  // A line at each start, end and failure: the tag, the bytes and the milliseconds, nothing else.
  const said = lines.filter((line) => /event=local_model_pull_/.test(line)).map((line) => Object.fromEntries(line.split(" ").map((pair) => pair.split("="))));
  assert.deepEqual(said.map((line) => [line.event, line.tag]), [["local_model_pull_start", QWEN3_DEFAULT], ["local_model_pull_end", QWEN3_DEFAULT], ["local_model_pull_start", "qwen3:4b"], ["local_model_pull_failed", "qwen3:4b"]]);
  for (const line of said) {
    const keys = Object.keys(line).sort();
    assert.deepEqual(keys, line.event === "local_model_pull_start" ? ["at", "event", "tag"] : ["at", "bytes", "event", "ms", "tag"], JSON.stringify(line));
  }
  assert.equal(said[1].bytes, "1000");
});

test("a shared server (here one with no runner beside it) reads the machine but pulls nothing, in words, even with OLLAMA_HOST set", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  const ollama = await fakeOllama(t, { models: [], pullable: { [QWEN3_DEFAULT]: PULLED } });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined, runner: false, runnerApart: true, machine: async () => LINUX(32) });
  const view = (await api("GET", "/settings/local-model")).body;
  assert.equal(view.recommended.tag, QWEN3_DEFAULT);
  assert.equal(view.can_pull, false);
  assert.match(view.refused, /one owner's own server on their own machine, and this server runs no runner beside it/);
  const refused = await api("POST", "/settings/local-model/pull", { tag: QWEN3_DEFAULT });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /one owner's own server/);
  assert.deepEqual(ollama.got.pull, [], "nothing pulled");
});

test("no Ollama here: the read surface says to install it, and recommends nothing", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  // An Ollama that is not running, on a port this test holds (fixtures/fake-ollama.mjs `down`).
  const down = await fakeOllama(t, { down: true });
  withEnv(t, { OLLAMA_HOST: down.host });
  const { api } = await serve(t, { faux: undefined, runner: false, machine: async () => APPLE(32) });
  const view = (await api("GET", "/settings/local-model")).body;
  assert.deepEqual(view.ollama, { asked: true, reachable: false, version: null });
  assert.equal(view.recommended.tag, null);
  assert.match(view.recommended.why, /ollama\.com\/download/);
});

// Under the model gateway or the faux model this server never asks Ollama (model.ts asksOllama): the read surface says
// so, and its words are the refusal alone, never that Ollama isn't running.
for (const [name, options, env, refusal] of [
  ["the model gateway", { faux: undefined }, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "synth-gateway", AGENT_MODEL_API_KEY: "fake-test-key" }, /model gateway \(AGENT_MODEL_BASE_URL\)/],
  ["the faux model", {}, {}, /faux model/],
]) {
  test(`under ${name}, the read surface says Ollama was not asked, and its only words are the refusal`, { timeout: 60_000 }, async (t) => {
    withEnv(t, {}, OWNER);
    const ollama = await fakeOllama(t, { models: [PULLED] });
    withEnv(t, { OLLAMA_HOST: ollama.host, ...env });
    const { api } = await serve(t, { runner: false, machine: async () => LINUX(32), ...options });
    const read = await api("GET", "/settings/local-model");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const view = read.body;
    assert.deepEqual(view.ollama, { asked: false, reachable: false, version: null });
    assert.equal(view.recommended.tag, null);
    assert.equal(view.can_pull, false);
    assert.match(view.refused, refusal);
    assert.equal(view.recommended.why, view.refused);
    assert.doesNotMatch(JSON.stringify(view), /isn't running|ollama\.com\/download/);
    assert.equal(ollama.got.version, 0, "the fake was never asked its version");
    assert.equal(ollama.got.tags, 0, "nor its tags");
  });
}
