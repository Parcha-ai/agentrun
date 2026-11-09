// No run row, journal end or runner event carries a secret value (the secrets decision's rule three): a thrown error's text
// that reaches one passes through the runner's one redactor (runner/redact.ts secretRedactor), which puts "[redacted]" in
// place of every value it holds, in every form. A planted key in each sink: a loop the runner cannot make (its row and its
// error event), a loop that ends failed in words (endRun), the adapter loop's own failed end (its journal end and the
// row), and the model route's error text that pi records (messagesFetch's SSE error event).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { messagesFetch } = await import("../dist/runner/model-route.js");
const redactModule = await import("../dist/runner/redact.js").catch(() => ({}));
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));

const PLANTED = `sk-planted-${"q7".repeat(16)}`;
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const redactor = () => fn(redactModule, "secretRedactor")([PLANTED]);
const settled = (opened, id) => until(async () => {
  const row = await opened.server.runs.get(id);
  return !["queued", "running"].includes(row.state) && row.runner === null && row;
}, `${id} settled`, 10_000);

/** A runner over `createLoop`, its redactor the planted key's, recording what it emits. */
async function runWith(t, createLoop) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const events = [];
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING, redact: redactor(), onEvent: (event) => events.push(event) });
  t.after(() => runner.close());
  return { opened, events, row: await settled(opened, "run-1") };
}

test("a loop the runner cannot make fails the run without the key in its row or its error event", async (t) => {
  const { row, events } = await runWith(t, () => {
    throw new Error(`could not start: the provider refused key ${PLANTED}`);
  });
  assert.equal(row.state, "failed");
  assert.ok(!String(row.summary).includes(PLANTED) && String(row.summary).includes("[redacted]"), `the row: ${row.summary}`);
  assert.ok(!JSON.stringify(events).includes(PLANTED), "no event carries it");
});

test("a loop that throws with no end written: the runner ends the run failed (endRun), its row saying why without the key", async (t) => {
  const { row } = await runWith(t, () => ({
    start: async () => {
      throw new Error(`the provider said 401 for ${PLANTED}`);
    },
    command: async () => ({ refused: "no commands here" }),
    stop: async () => {},
  }));
  assert.equal(row.state, "failed");
  assert.ok(!String(row.summary).includes(PLANTED) && String(row.summary).includes("[redacted]"), `the row: ${row.summary}`);
});

test("the adapter loop's own failed end: its journal end and the row say why without the key", async (t) => {
  /** A session that opens, then fails its turn with the key in the error, as a provider that echoes it would. */
  const echoing = {
    id: "echoing",
    capabilities: () => ({}),
    check: () => [],
    async open() {
      return {
        get state() { return "new"; },
        async send() { throw new Error(`the model's request failed: invalid x-api-key ${PLANTED}`); },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: async () => ({ status: "completed" }),
        async interrupt() {},
        async close() {},
      };
    },
  };
  const createLoop = createAdapterLoop(() => ({ adapter: echoing, session: { key: "root", label: "root", system: [], tools: [], context: "fresh" }, input: "Go.", hooks: quiet }));
  const { opened, row } = await runWith(t, createLoop);
  assert.equal(row.state, "failed");
  assert.ok(!String(row.summary).includes(PLANTED) && String(row.summary).includes("[redacted]"), `the row: ${row.summary}`);
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const end = entries.find((entry) => entry.kind === "agentrun.end");
  assert.ok(end, "the journal holds the end");
  assert.ok(!JSON.stringify(entries).includes(PLANTED), `no journal entry holds it: ${JSON.stringify(end.data)}`);
});

test("the runner's log holds no key: a run whose release throws with the key in its error logs the failure with the key cut", async (t) => {
  // What the runner writes to stderr and the console while the run goes (stdout is the test reporter's, left alone).
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  const consoled = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoled[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  t.after(() => {
    process.stderr.write = write;
    for (const [level, f] of Object.entries(consoled)) console[level] = f;
  });
  /** A session that answers at once: the run ends, then its release is let go. */
  const answering = {
    id: "answering",
    capabilities: () => ({}),
    check: () => [],
    async open() {
      let state = "new";
      return {
        get state() { return state; },
        async send() { state = "idle"; },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: async () => ({ status: "completed" }),
        async interrupt() {},
        async close() {},
      };
    },
  };
  const createLoop = createAdapterLoop(() => ({
    adapter: answering, session: { key: "root", label: "root", system: [], tools: [], context: "fresh" }, input: "Go.", hooks: quiet,
    release: async () => { throw new Error(`the computer's release was refused for key ${PLANTED}`); },
  }));
  const { row } = await runWith(t, createLoop);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const log = await until(async () => {
    const text = lines.join("\n");
    return text.includes("release failed") && text;
  }, "the release's failure logged", 10_000);
  assert.ok(!log.includes(PLANTED), `the runner's log holds no key: ${log.slice(-300)}`);
  assert.match(log, /release failed: .*\[redacted\]/, "it says the release failed, the key cut");
});

test("a run spec's own log lines hold no key: a CLI run's computer release refused with the key in the env logs the failure with it cut", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
  const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
  const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
  process.env.AGENTRUN_OPENCODE_STANDIN = "1";
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-spec-redact-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let harness;
  t.after(async () => {
    await harness?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "opencode", tools: ["read"] } });
  const launch = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-5" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const standIn = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
  // The runner's environment holds the key; the computer's release echoes it.
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: PLANTED, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [standIn] }) };
  const logged = [];
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => assert.fail("no pi route"), log: (line) => logged.push(line),
    computerForClaim: async () => ({ release: async () => { throw new Error(`the computer refused to go, key ${PLANTED}`); } }),
  };
  const built = await cliRunSpecFromLaunch(launch, { harness, registry, setModels: (given) => (models = given) }, deps, claim);
  await built.release?.();
  const text = logged.join("\n");
  assert.match(text, /computer could not be let go/, `the release's failure is logged: ${text}`);
  assert.ok(!text.includes(PLANTED) && text.includes("[redacted]"), `the spec's log holds no key: ${text}`);
});

test("the model route's error text, which pi records, holds no key: the SSE error event is redacted", async () => {
  const models = {
    streamSimple: () => (async function* () {
      yield { type: "error", reason: "error", error: { errorMessage: `401 Unauthorized: invalid key ${PLANTED}` } };
    })(),
  };
  const target = { id: "faux-model", provider: "faux", api: "faux", baseUrl: "http://127.0.0.1:9", maxTokens: 1024 };
  const send = messagesFetch(models, target, redactor());
  const response = await send("http://route.invalid/v1/messages", { body: JSON.stringify({ model: "faux-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });
  const text = await response.text();
  assert.ok(text.includes("event: error"), `an error event: ${text.slice(0, 200)}`);
  assert.ok(!text.includes(PLANTED) && text.includes("[redacted]"), `the error text: ${text.slice(-300)}`);
});
