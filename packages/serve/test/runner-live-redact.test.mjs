// A run's live view (run_live) never holds a secret the runner holds: the live ticker cuts every value of a run's held
// state (a running tool's name, its args and its streamed output, the partial answer) with the run's one redactor (the
// runner's, LoopDeps.redact, the one its journal's text goes through) before it writes it. The live stream a console
// watches (live/stream.ts watchRun) builds its held events from that row alone (heldEvents: a running tool's name and
// args, the partial answer), so it shows the secret cut, never whole. A loop given no redactor writes no live view.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { inspect } from "node:util";
import { until } from "./runner-support.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { streamingSandbox } from "./fixtures/streaming-sandbox.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { secretRedactor } = await import("../dist/runner/redact.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runFolder } = await import("../dist/workspace/paths.js");
after(closeOpenSessions);
const { openSqliteStore } = await import("../dist/store/index.js");
const { withLiveTicker } = await import("../dist/runner/live-ticker.js");

/** A value the runner holds as a secret (long enough to be one), never in the clear in a test's own source. */
const SECRET = `held-live-${"k".repeat(12)}-${"7".repeat(12)}`;
/** A held value of digits alone (a gateway's key can be), which a tool's args can quote as a JSON number. */
const DIGITS = `4${"8".repeat(11)}`;

test("a run's live view holds its running tool's name, args and output and its partial answer cut of a held secret: the row the store keeps and the live stream serves, a secret paused mid-stream showing none of itself", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-redact-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let release = () => {};
  let runner;
  t.after(async () => {
    release();
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // The loop reports a running bash whose args quote the secrets (as text, as a number, as two property names) and whose
  // output and answer stream the secret: first paused halfway through it, then past it. Each report is read at a tick.
  let given;
  let givenDeps;
  let report = () => {};
  const createLoop = (deps) => ({
    start: async () => {
      given = deps.redact;
      givenDeps = deps;
      report = (state) => deps.live?.(() => state);
      await new Promise((resolve) => (release = resolve));
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "this loop takes no commands" }),
    stop: async () => release(),
  });
  runner = startRunner({ store, createLoop, redact: secretRedactor([SECRET, DIGITS]), live: { tickMs: 20 }, name: "runner-a", leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 });
  await until(() => given, "the run's loop started");
  // Every loop the runner makes is handed its one redactor (a production runner, the runner beside the server and the
  // conformance harness all build their loops through startRunner), and it knows its values.
  assert.ok([SECRET, DIGITS].every((value) => given.heldValues?.().includes(value)), "the runner hands its loop the run's redactor, its values known");
  // Its values are only a function's answer, that function not enumerable: the redactor and the deps holding it, logged or
  // serialized, show none of them.
  for (const [what, value] of [["the redactor", given], ["the loop's deps", givenDeps]]) {
    const shown = [JSON.stringify(value) ?? "", inspect(value, { showHidden: true, depth: Infinity, getters: true })].join("\n");
    assert.ok(![SECRET, DIGITS].some((held) => shown.includes(held)), `${what}, serialized or inspected, shows a held value`);
  }
  const args = { command: `echo ${SECRET}`, env: { TOKEN: SECRET }, count: Number(DIGITS), keyed: { [SECRET]: 1, [DIGITS]: 2 } };
  const head = "x".repeat(300);
  const rowWith = async (mark) => {
    let row;
    await until(async () => JSON.stringify((row = (await server.live.read(["run-1"]))[0]?.state) ?? {}).includes(mark), `the run's live row with ${mark}`, 15_000);
    return row;
  };

  // Paused halfway through the secret at a tick: the row shows none of its head, the text before it kept.
  const half = SECRET.slice(0, 20);
  report({ tools: [{ callId: "call-1", name: "bash", args, output: `${head}token ${half}` }], partial: { text: `${head}the key is ${half}` } });
  const paused = await rowWith("xxxx");
  const pausedText = JSON.stringify(paused);
  assert.equal(pausedText.includes(SECRET.slice(0, 8)), false, `the half-streamed secret's head is in the live row: ${pausedText}`);
  assert.ok(paused.tools[0].output.startsWith("xxxx") && paused.partial.text.startsWith("xxxx"), `the text before it is kept: ${pausedText}`);
  // The args: text cut in place; a number that is a held value withheld; an object whose two names both cut the same withheld
  // whole, never one value kept over the other.
  assert.deepEqual(paused.tools[0].args, { command: "echo [redacted]", env: { TOKEN: "[redacted]" }, count: "[redacted]", keyed: "[redacted]" });

  // Streamed past it: the secret shows cut, what follows it kept up to the held-back tail.
  const tail = "y".repeat(300);
  report({ tools: [{ callId: "call-1", name: "bash", args, output: `${head}token ${SECRET}\n${tail}` }], partial: { text: `${head}the key is ${SECRET} ${tail}` } });
  const past = await rowWith("[redacted]\\n");
  const pastText = JSON.stringify(past);
  assert.equal(pastText.includes(SECRET.slice(0, 8)) || pastText.includes(DIGITS), false, `the live row holds a secret: ${pastText}`);
  assert.ok(past.tools[0].output.includes("token [redacted]\nyyy") && past.partial.text.includes("the key is [redacted] yyy"), `the secret cut, the rest kept: ${pastText}`);
});

// A run with no mounting computer has no shell (#2088): this run's claim is handed a sandbox bound to its folder
// (fixtures/streaming-sandbox.mjs), whose processes stream as computerd's do, so its bash exists and streams.
test("a real pi run's running bash streaming a held secret: its live row (and so the live stream, which serves that row) holds the output cut", async (t) => {
  // Through the real stack: the pi adapter's session on a scripted model, the runner's own ticker and redactor (the runner
  // holds the secret by its environment, a key's name), the kernel's bash over the run's Workspace streaming its output
  // into pi's live slot. The bash prints the secret, then waits for the test's release file: its live row is read while
  // it runs. The live stream builds its held events from this same row (live/stream.ts heldEvents), never another.
  const before = process.env.AGENTRUN_TEST_LIVE_TOKEN;
  process.env.AGENTRUN_TEST_LIVE_TOKEN = SECRET;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_TEST_LIVE_TOKEN : (process.env.AGENTRUN_TEST_LIVE_TOKEN = before)));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-redact-pi-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Run it.", tools: ["bash"] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } });
  const folder = runFolder(dir, "agent-1", "run-1");
  mkdirSync(folder, { recursive: true });
  // Past the secret it prints more than the tail the live view holds back (as long as the widest form of the longest value
  // the runner holds, its environment's among them), so the head, the secret cut in it, shows while the bash still runs.
  const command = `echo "token ${SECRET}"; head -c 20000 /dev/zero | tr '\\0' y; while [ ! -e release ]; do sleep 0.05; done`;
  const requests = [];
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"r"}` },
    fetch: scriptedOrigin([{ call: "bash", args: { command } }, { say: "done" }], requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1_000,
  };
  const deps = { env: { AGENTRUN_TEST_LIVE_TOKEN: SECRET }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route, computerForClaim: async () => streamingSandbox(folder) };
  runner = startRunner({ store, name: "runner-a", live: { tickMs: 50 }, leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }) });
  let row;
  try {
    await until(async () => {
      row = (await server.live.read(["run-1"]))[0]?.state;
      return (row?.tools ?? []).some((tool) => tool.name === "bash" && typeof tool.output === "string" && tool.output.includes("token "));
    }, "the running bash's output in its live row", 30_000).catch(async (error) => {
      throw new Error(`${error.message}; the last row ${JSON.stringify(row)}; the run ${JSON.stringify(await server.runs.get("run-1"))}; offered ${JSON.stringify(requests.map((r) => (r.tools ?? []).map((tool) => tool.name)))}`);
    });
  } finally {
    writeFileSync(join(folder, "release"), "");
  }
  const held = JSON.stringify(row);
  assert.equal(held.includes(SECRET.slice(0, 8)), false, `the live row holds the secret: ${held.slice(0, 400)}`);
  assert.ok(held.includes("token [redacted]"), `the secret cut, the rest of the output kept: ${held.slice(0, 400)}`);
});

test("a loop given no redactor has no live view: its held state is never written, so never written uncut", async (t) => {
  // The ticker over a store whose live puts are counted; the loop's deps carry no redactor.
  const puts = [];
  const store = { live: { put: async (rows) => void puts.push(...rows), drop: async () => {}, read: async () => [] } };
  const ticker = withLiveTicker(store, (deps) => ({
    start: async () => {
      deps.live?.(() => ({ tools: [{ callId: "call-1", name: "bash", output: `token ${SECRET}\n` }] }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "no" }),
    stop: async () => {},
  }), { tickMs: 10 });
  t.after(() => ticker.close());
  const loop = ticker.createLoop({ journal: () => undefined, flush: async () => {}, signal: new AbortController().signal });
  await loop.start({ runId: "run-1", runner: "runner-a", epoch: 1, until: Date.now() + 60_000, from: "queued" });
  await ticker.close();
  assert.deepEqual(puts, [], `nothing put for a loop with no redactor: ${JSON.stringify(puts)}`);
});
