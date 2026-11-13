// A person's follow-up to a completed CLI run (claude-agent, codex), as the runner runs it: the run ends, the store reopens
// it with the follow-up's steer (runs.reopen), and the runner claims it again and runs that steer as a new turn on the
// session the run's journal holds. The follow-up answers, the run ends again, and both turns are on its timeline. Before
// the CLI record wrote a reopen's follow-up as its own entry (adapter-loop.ts CliRecord.followUp), the reopened run was
// claimed and sat running for good: its row waited on a pi submission no CLI harness writes. pi's case is
// runner-follow-up-reopen.test.mjs. (rt-hand-1's probe.)
// claude-agent runs the pinned SDK and CLI, linked as a first use installs them, against a fake Anthropic; codex runs on
// Codex's app-server stand-in against a Responses gateway on loopback. No key, no network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { linkHarnesses } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CODEX_STANDIN_ENV } = await import("../dist/adapters.js");
const { DATA_ENV } = await import("../dist/server-fs.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const RUN = "run-1";
const until = async (done, what, ms = 60_000) => {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 25))) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
  }
};

/** A Responses gateway on loopback: every request counted, each answered `text`. */
async function responsesGateway(t, text) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push(body);
    const events = [{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}

const HARNESSES = {
  "claude-agent": async (t, dir) => {
    const fake = await fakeAnthropic({ reply: () => ({ text: "Answered." }) });
    t.after(() => fake.close());
    await linkHarnesses(dir);
    return { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, env: { [DATA_ENV]: dir, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url }, requests: () => fake.messages().length, asked: () => fake.messages().map((one) => one.text) };
  },
  codex: async (t, dir) => {
    const was = process.env.AGENTRUN_CODEX_STANDIN;
    process.env.AGENTRUN_CODEX_STANDIN = "1";
    t.after(() => (was === undefined ? delete process.env.AGENTRUN_CODEX_STANDIN : (process.env.AGENTRUN_CODEX_STANDIN = was)));
    const gateway = await responsesGateway(t, "Answered.");
    const standIn = join(dir, "codex-stand-in.mjs");
    await copyStandIn(standIn);
    return { model: { provider: "openai", modelId: "gpt-test" }, env: { [CODEX_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }), AGENT_MODEL_BASE_URL: gateway.origin, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5" }, requests: () => gateway.seen.length, asked: () => [...gateway.seen] };
  },
};

for (const harness of Object.keys(HARNESSES)) {
  test(`a follow-up to a completed ${harness} run reopens it on the runner, runs one turn, answers and ends`, { timeout: 180_000 }, async (t) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cli-reopen-"));
    const server = await openSqliteStore({ dataDir: dir, role: "server" });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    let runner;
    t.after(async () => {
      await runner?.close().catch(() => {});
      await store.close().catch(() => {});
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    const { model, env, requests } = await HARNESSES[harness](t, dir);
    await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness, tools: ["read"] } });
    await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness, model } });
    await server.flush?.();
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
    runner = startRunner({ store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }) });
    const rows = async () => (await runTimeline(server, RUN, ctx)).map((row) => [row.kind, row.text ?? row.summary ?? row.tool_name]);

    const first = await until(async () => { const row = await server.runs.get(RUN); return ["ended", "failed", "stopped"].includes(row.state) && row.runner === null && row; }, "the first turn's end");
    assert.equal(first.state, "ended", `the first turn ended: ${JSON.stringify(first)} ${JSON.stringify(await rows())}`);
    const before = requests();

    await server.runs.reopen(RUN, { kind: "steer", body: { text: "And once more?" } });
    await server.flush?.();
    let last;
    await until(async () => {
      const row = (last = await server.runs.get(RUN));
      return (row.endedAt ?? 0) > (first.endedAt ?? 0) && ["ended", "failed", "stopped"].includes(row.state) && row.runner === null && row;
    }, "the follow-up's end").catch(async (error) => assert.fail(`${error.message}: the run is ${JSON.stringify(last)}; ${requests() - before} model requests since the reopen; timeline ${JSON.stringify(await rows())}`));
    assert.equal(last.state, "ended", `the follow-up ended: ${JSON.stringify(last)}`);
    assert.ok(requests() > before, "the follow-up's turn asked the model");
    const seen = await rows();
    const said = seen.filter(([kind]) => kind === "user_message").map(([, text]) => text);
    assert.deepEqual(said, ["Say hello.", "And once more?"], `both of the person's messages on the timeline: ${JSON.stringify(seen)}`);
    assert.equal(seen.filter(([kind]) => kind === "final_answer").length, 2, `an answer for each turn: ${JSON.stringify(seen)}`);
  });

  // pi's case is runner-message-while-working.test.mjs: a message sent as soon as the run's 202 came back is handed to the
  // runner's first claim with the session still new, and must land after the run's own input.
  test(`a message sent to a ${harness} run before the runner sent its input lands after the input, on the timeline and in what the model reads`, { timeout: 180_000 }, async (t) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cli-first-"));
    const server = await openSqliteStore({ dataDir: dir, role: "server" });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    let runner;
    t.after(async () => {
      await runner?.close().catch(() => {});
      await store.close().catch(() => {});
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    const { model, env, asked } = await HARNESSES[harness](t, dir);
    await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness, tools: ["read"] } });
    await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness, model } });
    const row = await server.command(RUN, { kind: "steer", body: { text: "And once more?" } });
    await server.flush?.();
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
    runner = startRunner({ store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }) });
    const rows = async () => (await runTimeline(server, RUN, ctx)).map((one) => [one.kind, one.text ?? one.summary ?? one.tool_name]);

    const end = await until(async () => { const now = await server.runs.get(RUN); return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now; }, "the run's end");
    assert.equal(end.state, "ended", `the run ended: ${JSON.stringify(end)} ${JSON.stringify(await rows())}`);
    const taken = (await server.commands(RUN, 0)).find((one) => one.id === row.id);
    assert.ok(taken && taken.takenAt !== null && taken.refused === null, `the message was taken, not refused or left: ${JSON.stringify(taken)}`);
    const seen = await rows();
    assert.deepEqual(seen.filter(([kind]) => kind === "user_message").map(([, text]) => text), ["Say hello.", "And once more?"], `the input, then the message: ${JSON.stringify(seen)}`);
    // The model is asked the input first: in the first request that carries the message, the input comes before it, or an
    // earlier request carried the input (a harness that sends each turn's words alone: codex's).
    const said = asked();
    const [input, message] = [said.findIndex((text) => text.includes("Say hello.")), said.findIndex((text) => text.includes("And once more?"))];
    assert.ok(input >= 0 && message >= 0, `the model was asked the input and the message: ${said.length} requests`);
    assert.ok(input < message || (input === message && said[input].indexOf("Say hello.") < said[input].indexOf("And once more?")), `the model reads the input before the message: ${said[message].slice(0, 400)}`);
  });
}
