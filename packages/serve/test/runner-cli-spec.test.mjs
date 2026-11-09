// A CLI harness's run as the runner runs it (runner/cli-run-spec.ts cliRunSpecFromLaunch): a run stored with its launch,
// claimed by a runner whose dispatch resolves a CLI harness to the kernel's adapter loop on this spec, runs its first
// turn and ends, its answer in the run's own record (record "loop"). The adapter is the one main builds for the harness
// (adapters.ts adapterFor: its provider on its wire, its catalog price); the run's tools are the kernel registry's hands
// on its Workspace, its gate the store's tool settings. Every harness here is a stand-in on loopback: no network, no key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { DATA_ENV } = await import("../dist/server-fs.js");
const { runFolder, scratchFolder } = await import("../dist/workspace/paths.js");
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

/** A gateway on loopback that answers OpenAI's Responses API with `text`, and records every request body. */
async function responsesGateway(t, text) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, body: JSON.parse(body || "{}") });
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: text },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}

/** A run of `harness` stored with its launch, and a runner whose dispatch resolves a CLI harness to cliRunSpecFromLaunch. */
async function runOn(t, { harness, model, env: envOf, prepare }) {
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
  const launch = { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness, model };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
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
  return { row, messages: messagesOf(entries), dir, computers };
}

/** A stored `harness` run's spec, built for its claim as the dispatch builds it (no session opened), with the CLI's
 *  working directory (the run's scratch). OpenCode on its stand-in: building its adapter starts nothing. */
async function specOn(t, harness) {
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
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness, tools: ["read", "write"] } });
  const launch = { input: { content: "Write a file." }, title: "t", place: { mode: "runner" }, harness, model: { provider: "openai", modelId: "gpt-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("no pi route"), computerForClaim: noComputer().forClaim };
  built = await spec.cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given) }, deps, claim);
  return { spec: built, dir, cwd: scratchFolder(dir, "agent-1", RUN) };
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
  assert.equal(gateway.seen.length, 1, "one model request, through the session's proxy to the gateway");
  assert.equal(gateway.seen[0].body.model, "openai/gpt-5", "the gateway's own name for the model, as main sends it there");
  const sent = JSON.stringify(gateway.seen[0].body.input);
  assert.ok(sent.includes("Answer briefly."), "the revision's instructions are in the session's system prompt");
  assert.ok(gateway.seen[0].body.tools.some((tool) => tool.name === "hands_read"), "the revision's read is the run's hand, OpenCode's only tool");
  // OpenCode works in the run's scratch folder on this machine (its working directory, which its prompt names), never the
  // run's disk folder.
  assert.ok(sent.includes(`Working directory: ${scratchFolder(dir, "agent-1", RUN)}`), `OpenCode's cwd is the run's scratch: ${sent.slice(0, 400)}`);
  // The run's computer came from the shared computerForClaim, and went with the run's release.
  assert.deepEqual(computers.asked.map((one) => [one.place, one.store]), [[{ mode: "runner" }, true]]);
  assert.equal(computers.released(), 1);
});

test("a CLI's absolute path under its working directory is the run's folder: a write to <cwd>/x.txt lands as the workspace's x.txt, and a path outside both is refused", async (t) => {
  const { spec: built, dir, cwd } = await specOn(t, "opencode");
  const write = built.session.tools.find((tool) => tool.name === "write");
  const call = (args) => write.call(args, { callId: `c-${Math.random()}`, signal: new AbortController().signal });
  const landed = await call({ path: join(cwd, "x.txt"), content: "from the CLI" });
  assert.equal(landed.isError, false, landed.text);
  assert.equal(readFileSync(join(runFolder(dir, "agent-1", RUN), "x.txt"), "utf8"), "from the CLI");
  const outside = await call({ path: join(dir, "elsewhere.txt"), content: "no" });
  assert.equal(outside.isError, true, "a path outside the run's folder and the CLI's cwd is refused");
  assert.equal(existsSync(join(dir, "elsewhere.txt")), false);
});
