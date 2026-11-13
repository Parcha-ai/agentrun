// A CLI harness's run as the runner runs it (runner/cli-run-spec.ts cliRunSpecFromLaunch): a run stored with its launch,
// claimed by a runner whose dispatch resolves a CLI harness to the kernel's adapter loop on this spec, runs its first
// turn and ends, its answer in the run's own record (record "loop"). The adapter is the one main builds for the harness
// (its harness-table.ts entry's adapter: its provider on its wire, its catalog price); the run's tools are the kernel registry's hands
// on its Workspace, its gate the store's tool settings. Every harness here is a stand-in on loopback: no network, no key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { DATA_ENV } = await import("../dist/server-fs.js");
const { runFolder, runKey, scratchFolder } = await import("../dist/workspace/paths.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
/** The server's Archil settings (archil-settings.ts): their presence is Mode 2. */
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");
const { linkHarnesses } = await import("./support.mjs");
const spec = await import("../dist/runner/cli-run-spec.js").catch(() => ({}));

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A gateway on loopback that answers OpenAI's Responses API with `text`, and records each model request's body
 *  (`seen`: every POST to /responses). Anything else that reaches its port is no model request: a host's loopback prober
 *  (a keyless `GET /`, as codex-run's and opencode-run's gateways pass over) is kept apart (`stray`), answered 404, and
 *  never counted as one. */
async function responsesGateway(t, text) {
  const seen = [];
  const stray = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST" || !new URL(req.url, "http://gateway").pathname.endsWith("/responses")) {
      stray.push(`${req.method} ${req.url} (${req.headers["user-agent"] ?? "no user agent"})`);
      res.writeHead(404).end();
      return;
    }
    seen.push({ path: req.url, at: Date.now(), body: JSON.parse(body || "{}") });
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: text },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, stray, origin: `http://127.0.0.1:${server.address().port}` };
}

/** A claim of the stored run taken by a runner that dies at once (`runner-dead`, a lease that runs out at once), its CLI's
 *  private folder left as a killed runner leaves it (the CLI's home with a session file in it), then its lease lapsed:
 *  the next claim takes the run at the next epoch, "Resumed after its runner (…) was lost". Answers the dead claim. */
async function deadClaim(store, dir) {
  const [dead] = await store.runs.claimMany("runner-dead", 1, { leaseMs: 1 });
  assert.ok(dead, "the dead runner claimed the run");
  const home = join(scratchFolder(dir, "agent-1", RUN), "harness", String(dead.epoch), "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "session.json"), "{}");
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dead;
}

/** A run of `harness` stored with its launch (`launch`: more of its body, as the server writes it), and a runner whose
 *  dispatch resolves a CLI harness to cliRunSpecFromLaunch. `crashed`: a first claim died with its folder in place
 *  (deadClaim) before this runner starts. */
async function runOn(t, { harness, model, env: envOf, prepare, launch: more = {}, crashed = false }) {
  assert.equal(typeof spec.cliRunSpecFromLaunch, "function", "runner/cli-run-spec.js exports cliRunSpecFromLaunch");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-spec-"));
  await prepare?.(dir);
  const env = typeof envOf === "function" ? envOf(dir) : envOf;
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness, tools: ["read"] } });
  const launch = { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness, model, ...more };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const dead = crashed ? await deadClaim(store, dir) : undefined;
  const computers = noComputer();
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: computers.forClaim };
  runner = startRunner({
    store,
    name: "runner-a",
    ...CONFORMANCE_TIMING,
    leaseMs: 30_000,
    stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => spec.cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, messages: messagesOf(entries), dir, computers, server, dead };
}

/** A stored `harness` run's spec, built for its claim as the dispatch builds it (no session opened), with the CLI's
 *  working directory (the run's scratch). OpenCode on its stand-in: building its adapter starts nothing. `archil`: Mode 2
 *  over that disk fake, Archil's control plane the fake as a fetch function (`control`: no port, every request recorded). `env`: more of the
 *  runner's environment; `model`: the launch's model; `crashed`: a first claim died with its folder in place (deadClaim). */
async function specOn(t, harness, { archil, env: more = {}, model = { provider: "openai", modelId: "gpt-5" }, prepare, deps: given = {}, crashed = false } = {}) {
  const control = archil ? archilControlFetch() : undefined;
  // A second net: in Mode 2, any fetch to a host other than this machine's loopback is refused and recorded (`outbound`).
  const outbound = [];
  if (archil) {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        outbound.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
        throw new Error(`a test reached ${url.origin}: no call leaves this machine`);
      }
      return original(input, init);
    };
    t.after(() => void (globalThis.fetch = original));
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-spec-"));
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
  await prepare?.(dir);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness, tools: ["read", "write", "bash"] } });
  const launch = { input: { content: "Write a file." }, title: "t", place: { mode: "runner" }, harness, model };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  // Mode 2: the server's Archil settings row, and its account key sealed under the runner's seal key, as the server saves
  // them. No disk token is kept: a computer's mount credential is minted per run from the account key.
  if (archil) {
    await saveArchilSettings(server, ARCHIL_SETTINGS);
    // The agent's own disk, made by an earlier run (run-disk.ts): this run keeps its folder there.
    await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
    await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  }
  await server.flush?.();
  const dead = crashed ? await deadClaim(store, dir) : undefined;
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }), ...more };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("no pi route"), computerForClaim: noComputer().forClaim, ...(archil ? { makeArchilDisk: () => archil, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } } : {}), ...given };
  built = await spec.cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given) }, deps, claim);
  return { spec: built, dir, cwd: scratchFolder(dir, "agent-1", RUN), control, outbound, claim, dead };
}

/** The shared computerForClaim(launch, store, deps), stood in for a runner place: no computer, and its release counted.
 *  Test only: the runner's own lands with the computers work. */
function noComputer() {
  const asked = [];
  let released = 0;
  return {
    asked,
    released: () => released,
    forClaim: async (launch, store, deps) => {
      asked.push({ place: launch.place, store: typeof store?.runs?.get === "function", deps });
      return { release: async () => void (released += 1) };
    },
  };
}

// Ported from date-line.test.mjs: every harness's system prompt starts with one line saying today's date in UTC and where
// the run works, the same line pi's spec puts first (runner-system-prompt.test.mjs), before the revision's instructions.
for (const harness of ["claude-agent", "codex", "opencode"]) {
  test(`the ${harness} session's system prompt starts with the environment line, the same as pi's, then the revision's instructions`, async (t) => {
    const { environmentLine } = await import("../dist/environment.js");
    // The data directory's harnesses, linked as a first use installs them.
    const model = harness === "claude-agent" ? { provider: "anthropic", modelId: "claude-haiku-4-5" } : undefined;
    const { spec: built } = await specOn(t, harness, { prepare: (data) => linkHarnesses(data), ...(model ? { model, env: { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` } } : {}) });
    assert.equal(built.session.system[0], environmentLine(), "the date line first");
    assert.match(built.session.system[0], /^Today is \d{4}-\d{2}-\d{2} \(UTC\)\./);
    assert.equal(built.session.system[1], "Answer.", "then the revision's instructions");
  });
}

test("a claude-agent run, claimed by the runner, runs its first turn through the dispatch on the CLI spec, on the pinned Agent SDK and CLI, and ends with its answer", { timeout: 180_000 }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Hello from Claude." }) });
  t.after(() => fake.close());
  const { row, messages, dir } = await runOn(t, {
    harness: "claude-agent",
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    // The data directory's harnesses: the pinned SDK and CLI, linked as a first use installs them.
    prepare: (data) => linkHarnesses(data),
    env: (data) => ({ [DATA_ENV]: data, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url }),
  });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["person", "Say hello."], ["model", "Hello from Claude."]]);
  const sent = fake.messages();
  assert.ok(sent.length >= 1, "the CLI's requests reached the endpoint, through the session's proxy");
  assert.ok(sent.every((request) => request.body?.model === "claude-haiku-4-5"), "on Anthropic's own id");
  assert.ok(JSON.stringify(sent[0].body?.system ?? "").includes("Answer briefly."), "the revision's instructions are in the session's system prompt");
  void dir;
});

test("an opencode run, claimed by the runner, runs its first turn through the dispatch on the CLI spec and ends with its answer", async (t) => {
  const gateway = await responsesGateway(t, "Hello from OpenCode.");
  const env = {
    AGENT_MODEL_BASE_URL: gateway.origin,
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }),
  };
  const { row, messages, dir, computers } = await runOn(t, { harness: "opencode", model: { provider: "openai", modelId: "gpt-5" }, env });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["person", "Say hello."], ["model", "Hello from OpenCode."]]);
  // Each model request said, so a second one names what it re-sent and whether the run was claimed again (its epoch).
  assert.equal(gateway.seen.length, 1, `one model request, through the session's proxy to the gateway: ${JSON.stringify(gateway.seen.map((one) => ({ at: one.at, input: one.body.input?.map((item) => item.role ?? item.type) })))} epoch ${row.epoch}; not model requests: ${JSON.stringify(gateway.stray)}`);
  assert.equal(gateway.seen[0].body.model, "openai/gpt-5", "the gateway's own name for the model, as main sends it there");
  const sent = JSON.stringify(gateway.seen[0].body.input);
  assert.ok(sent.includes("Answer briefly."), "the revision's instructions are in the session's system prompt");
  assert.ok(gateway.seen[0].body.tools.some((tool) => tool.name === "hands_read"), "the revision's read is the run's hand, OpenCode's only tool");
  // OpenCode works in the run's scratch folder on this machine (its working directory, which its prompt names), never the
  // run's disk folder.
  assert.ok(sent.includes(`Working directory: ${scratchFolder(dir, "agent-1", RUN)}`), `OpenCode's cwd is the run's scratch: ${sent.slice(0, 400)}`);
  // The run's computer came from the shared computerForClaim, and went with the run's release.
  assert.deepEqual(computers.asked.map((one) => [one.place, one.store]), [[{ mode: "runner" }, true]]);
  // The release follows the run's end commit (the loop lets its resources go after it), so it is waited for, not raced.
  await until(() => computers.released() === 1, "the computer's release");
  assert.equal(computers.released(), 1, "released once");
});

// A CLI's files on this machine (its working directory, its private folder) are the claim's own: swept when the claim
// ends (#2166). Each claim's private folder is its own (harness/<epoch>), so a claim that lets go late (its release
// follows the run's end commit) sweeps only its own: a next claim's folder, and the scratch folder holding it, stay.
test("a CLI run's scratch folder is swept at its claim's end", async (t) => {
  const gateway = await responsesGateway(t, "Hello from OpenCode.");
  const env = { AGENT_MODEL_BASE_URL: gateway.origin, AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const { row, dir } = await runOn(t, { harness: "opencode", model: { provider: "openai", modelId: "gpt-5" }, env });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const scratch = scratchFolder(dir, "agent-1", RUN);
  await until(() => !existsSync(scratch), `the scratch folder swept at the claim's end: ${scratch}`, 10_000);
  assert.equal(existsSync(dirname(scratch)), false, "the agent's scratch folder goes with its last run's");
});

// A runner killed mid-claim never runs its claim's release, so its CLI's home and session state stay in harness/<epoch>.
// The next claim of the run (here the one that resumes it after the lost runner) sweeps every earlier claim's folder,
// and at the run's end the run's scratch folder goes whole: nothing the dead CLI wrote outlives the run.
test("a CLI run whose runner died mid-claim: the dead claim's folder is swept and the run's scratch folder goes at its end", async (t) => {
  const gateway = await responsesGateway(t, "Hello from OpenCode.");
  const env = { AGENT_MODEL_BASE_URL: gateway.origin, AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const { row, dir, dead } = await runOn(t, { harness: "opencode", model: { provider: "openai", modelId: "gpt-5" }, env, crashed: true });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.ok(row.epoch > dead.epoch, `the run was claimed again after the dead claim (epoch ${dead.epoch} → ${row.epoch})`);
  const scratch = scratchFolder(dir, "agent-1", RUN);
  const left = () => (existsSync(scratch) ? readdirSync(scratch, { recursive: true }).join(", ") : "nothing");
  await until(() => !existsSync(scratch), `the run's scratch folder swept at its end; left: ${left()}`, 10_000);
});

// A claim's start sweeps what earlier claims of its run left (a killed runner's): its own folder and another run's stay.
test("a CLI claim's start sweeps every earlier claim's folder of its run, never its own or another run's", async (t) => {
  const other = (dir) => join(scratchFolder(dir, "agent-1", "run-2"), "harness", "1", "home");
  const { dir, cwd, claim, dead } = await specOn(t, "opencode", { crashed: true, prepare: (dir) => mkdirSync(other(dir), { recursive: true }) });
  assert.ok(claim.epoch > dead.epoch, `claimed after the dead claim (epoch ${dead.epoch} → ${claim.epoch})`);
  assert.equal(existsSync(join(cwd, "harness", String(dead.epoch))), false, "the dead claim's folder is gone at the next claim's start");
  assert.equal(existsSync(join(cwd, "harness", String(claim.epoch))), true, "the claim's own folder is laid");
  assert.equal(existsSync(other(dir)), true, "another run's folder stays");
});

test("a claim's sweep removes its own private folder, and the scratch folder only once no other claim's is in it", async (t) => {
  assert.equal(typeof spec.sweepScratch, "function", "runner/cli-run-spec.js exports sweepScratch");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agent = join(dir, "scratch", "agent-1");
  const scratch = join(agent, "run-1");
  const harnesses = join(scratch, "harness");
  const parents = [harnesses, scratch, agent];
  for (const epoch of ["1", "2"]) mkdirSync(join(harnesses, epoch, "codex-home"), { recursive: true });
  mkdirSync(join(agent, "run-2", "harness", "1"), { recursive: true });
  await spec.sweepScratch(harnesses, 1, parents);
  assert.equal(existsSync(join(harnesses, "1")), false, "the late claim's own folder is gone");
  assert.equal(existsSync(join(harnesses, "2", "codex-home")), true, "the next claim's folder stays, whole");
  await spec.sweepScratch(harnesses, 2, parents);
  assert.equal(existsSync(scratch), false, "the last claim's sweep takes the scratch folder with it");
  assert.equal(existsSync(join(agent, "run-2", "harness", "1")), true, "another run's folder stays, and the agent's folder with it");
  await spec.sweepScratch(harnesses, 3, parents);
  rmSync(join(agent, "run-2"), { recursive: true });
  await spec.sweepScratch(join(agent, "run-3", "harness"), 1, [join(agent, "run-3", "harness"), join(agent, "run-3"), agent]);
  assert.equal(existsSync(agent), false, "the agent's scratch folder goes once no run's is in it");
});

// A killed runner's claim, and a sweep cut off partway (the runner killed while it removed): whatever is left of an
// earlier claim's folder, a later claim of the run removes at its start (sweepEarlier) or its end (sweepScratch), and a
// sweep run twice over the same state does nothing more. A later claim's folder is never touched.
test("a sweep cut off partway is finished by the run's next sweep, and an earlier claim's leftovers never outlive the run", async (t) => {
  assert.equal(typeof spec.sweepEarlier, "function", "runner/cli-run-spec.js exports sweepEarlier");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = join(dir, "scratch", "agent-1", "run-1");
  const harnesses = join(scratch, "harness");
  const parents = [harnesses, scratch, dirname(scratch)];
  // Claim 1 died with its CLI's home whole; claim 2's own sweep was cut off partway (its home half removed).
  mkdirSync(join(harnesses, "1", "home", "sessions"), { recursive: true });
  writeFileSync(join(harnesses, "1", "home", "sessions", "a.jsonl"), "{}\n");
  mkdirSync(join(harnesses, "2", "home"), { recursive: true });
  mkdirSync(join(harnesses, "4", "home"), { recursive: true });
  await spec.sweepEarlier(harnesses, 3);
  assert.deepEqual(readdirSync(harnesses), ["4"], "claim 3's start sweeps 1 and 2, never the later claim 4's folder");
  await spec.sweepEarlier(harnesses, 3);
  assert.deepEqual(readdirSync(harnesses), ["4"], "run again, it does nothing more");
  // Claim 4's end sweep cut off after its own folder went, before its parents did: the next sweep finishes it.
  rmSync(join(harnesses, "4"), { recursive: true });
  await spec.sweepScratch(harnesses, 4, parents);
  assert.equal(existsSync(dirname(scratch)), false, "the run's and the agent's scratch folders are gone");
  await spec.sweepScratch(harnesses, 4, parents);
  await spec.sweepEarlier(harnesses, 5);
});

// A run whose effort is above its harness's highest level (a revision's or the host's "max"; OpenCode's and Codex's
// reasoning stops at xhigh) thinks at that highest, and its metrics name the level it ran at, never the one it asked for.
test("a CLI run's effort above its harness's highest runs at that highest, and its metrics name the level it ran at", async (t) => {
  const gateway = await responsesGateway(t, "Done.");
  const env = { AGENT_MODEL_BASE_URL: gateway.origin, AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const { row } = await runOn(t, { harness: "opencode", model: { provider: "openai", modelId: "gpt-5" }, env, launch: { effort: "max" } });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.equal(row.metrics?.effort, "xhigh", `the metrics name the level it ran at: ${JSON.stringify(row.metrics)}`);
});

// A run a trigger started: its launch names the trigger and the first input's origin (run-launch.ts, as the server writes
// it at the firing), a schedule's with owner true (its owner wrote the words) and a webhook's with owner false. The CLI's
// record writes that first input as the trigger's, with the launch's own owner flag, never as the person's: so its
// Timeline shows a trigger row and no "You" row, and a webhook's payload never reads as the owner's words.
const TRIGGER = { id: "trg_0123456789abcdef01234567", firing_key: `fir_${"a".repeat(32)}` };
const LABEL = { schedule: "Schedule", webhook: "Webhook" };
for (const [source, owner] of [["schedule", true], ["webhook", false]]) {
  test(`an opencode run a ${source} trigger started journals its first input as the trigger's (owner ${owner}), never the person's: its Timeline shows the trigger's row, never "You"`, async (t) => {
    const gateway = await responsesGateway(t, "Hello from OpenCode.");
    const env = {
      AGENT_MODEL_BASE_URL: gateway.origin,
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
      [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }),
    };
    const origin = { kind: "trigger", trigger_id: TRIGGER.id, source, owner };
    const { row, messages, server } = await runOn(t, { harness: "opencode", model: { provider: "openai", modelId: "gpt-5" }, env, launch: { trigger: TRIGGER, input_origin: origin } });
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
    assert.deepEqual(messages.map((message) => [message.role, message.text, message.origin ?? null]), [["person", "Say hello.", origin], ["model", "Hello from OpenCode.", null]], "the first input is the trigger's, with the launch's owner flag");
    const rows = await runTimeline(server, RUN, ctx, { settled: true });
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), [], "no row reads as the person's");
    assert.deepEqual(rows.filter((r) => r.origin === "trigger").map((r) => [r.summary, r.trigger]), [[`${LABEL[source]} ${TRIGGER.id}: Say hello.`, { id: TRIGGER.id, source, owner }]]);
  });
}

test("a CLI's install is looked up in the server's data directory (deps.data), as main's server names it to its runs (AGENTRUN_SERVE_DATA), never under the runner's HOME/.local/share", async (t) => {
  // The runner's own environment names no data directory, and its HOME is a folder of the test's: claude-agent's Agent SDK
  // is installed in neither, so the claim installs it, into the server's data. The install is a stand-in that refuses,
  // naming where it was asked to install (no test reaches npm): the spec says where it looked.
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_DATA_HOME: "", [DATA_ENV]: "", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` };
  const asked = [];
  const installForClaim = async (_entry, dir) => {
    asked.push(dir);
    throw new Error(`Claude Code is not installed in ${dir}, and this test installs nothing`);
  };
  const failed = await specOn(t, "claude-agent", { env, model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, deps: { installForClaim } }).then(() => undefined, (error) => error);
  assert.ok(failed, "the Agent SDK is installed nowhere here, so the spec is refused");
  assert.equal(asked.length, 1, "the claim asked to install it, once");
  assert.match(failed.message, new RegExp(`${join(process.env.TMPDIR ?? tmpdir(), "runner-cli-spec-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/\\s]+/harnesses/claude-agent`), `looked up under the server's data: ${failed.message}`);
  assert.ok(!failed.message.includes(join(home, ".local", "share")), `nothing under the runner's HOME/.local/share: ${failed.message}`);
});

test("a CLI's absolute path under its working directory is the run's folder: a write to <cwd>/x.txt lands as the workspace's x.txt, and a path outside both is refused; with no computer in Mode 1 its granted bash is not among its tools", async (t) => {
  const { spec: built, dir, cwd } = await specOn(t, "opencode");
  const write = built.session.tools.find((tool) => tool.name === "write");
  const call = (args) => write.call(args, { callId: `c-${Math.random()}`, signal: new AbortController().signal });
  const landed = await call({ path: join(cwd, "x.txt"), content: "from the CLI" });
  assert.equal(landed.isError, false, landed.text);
  assert.equal(readFileSync(join(runFolder(dir, "agent-1", RUN), "x.txt"), "utf8"), "from the CLI");
  const outside = await call({ path: join(dir, "elsewhere.txt"), content: "no" });
  assert.equal(outside.isError, true, "a path outside the run's folder and the CLI's cwd is refused");
  assert.equal(existsSync(join(dir, "elsewhere.txt")), false);
  // Mode 1 with no computer: the run's folder is one of this server's own, so a command there would run on the server
  // itself. The CLI is handed no bash at all, granted or not.
  assert.deepEqual(built.session.tools.map((tool) => tool.name).filter((name) => name.startsWith("bash")), [], "no bash-family tool");
  assert.deepEqual(built.session.tools.map((tool) => tool.name).filter((name) => ["read", "write"].includes(name)).sort(), ["read", "write"], "the file tools stay");
});

test("Mode 2 (the server's Archil settings saved): the CLI still works in the run's scratch on this machine, a write to <cwd>/x.txt lands as x.txt in the run's folder on the Archil disk, and bash runs as Archil exec, at most 295 s", async (t) => {
  const disk = new FakeArchilDisk();
  const { spec: built, cwd, control, outbound } = await specOn(t, "opencode", { archil: disk });
  const call = (name, args) => built.session.tools.find((tool) => tool.name === name).call(args, { callId: `c-${Math.random()}`, signal: new AbortController().signal });
  const landed = await call("write", { path: join(cwd, "x.txt"), content: "from the CLI" });
  assert.equal(landed.isError, false, landed.text);
  assert.equal(Buffer.from(disk.files.get(`${runKey("agent-1", RUN)}/x.txt`) ?? "").toString("utf8"), "from the CLI", "on the disk, in the run's folder");
  const bash = built.session.tools.find((tool) => tool.name === "bash");
  assert.match(bash.description, /at most 295 s/, "Archil's serverless exec's ceiling");
  const ran = await call("bash", { command: "printf hi > y.txt" });
  assert.equal(ran.isError, false, ran.text);
  assert.ok(disk.calls.some((one) => one.op === "exec"), "bash ran as the disk's exec");
  assert.equal(Buffer.from(disk.files.get(`${runKey("agent-1", RUN)}/y.txt`) ?? "").toString("utf8"), "hi");
  // No computer: the run's mount credential is never minted, so Archil's control plane hears nothing, from build to end.
  await built.release();
  // Every request the claim made: the fake is a function only the claim holds, so nothing else on this machine reaches it.
  assert.deepEqual(control.requests, [], "no request at all: no list, no mint, no remove");
  assert.deepEqual(outbound, [], "and nothing left this machine");
});
