// The secrets decision on the runner (rules five and three): a secret never enters an agent's sandbox, child or computer;
// the server adds it at the edge (the model proxy, the MCP gateway); and no journal entry, store row or runner log
// carries a value. Distinct values are planted where the runner reads secrets (its environment: a model key, a tool key,
// a computer vendor key; the store: an MCP server's header, sealed), then real runs go through the runner's dispatch,
// and every place a value could reach is read for every planted one:
//   - a CLI run (OpenCode on its stand-in, its model a gateway on loopback): the child's own environment, written down by
//     a wrapper before it becomes the stand-in (fixtures/env-dump-standin.mjs);
//   - a pi run (adapterRunSpecFromLaunch, its model a scripted origin) whose agent runs `env` in its bash: what the bash
//     saw is the tool's output, in the journal and the next model request;
//   - each run's journal, the store's files (its tables, sealed columns opened by nobody here) and what the runner wrote
//     to stderr and the console.
// The pdf_pages tool (pdf-pages.ts:25, :137) runs its programs with this process's whole environment: its case reads a
// child's environment the same way, and is red until that file passes an environment of its own.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const cliSpec = await import("../dist/runner/cli-run-spec.js");
const { pdfPages } = await import("../dist/pdf-pages.js");
const { localWorkspace } = await import("../dist/workspace/index.js");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const ENV_DUMP = fileURLToPath(new URL("./fixtures/env-dump-standin.mjs", import.meta.url));
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
after(closeOpenSessions);

/** One distinct value per kind of secret, each long enough to be a key, none of them a real one. */
const PLANT = {
  AGENT_MODEL_API_KEY: `plantmodelgateway${"m1".repeat(12)}`,
  ANTHROPIC_API_KEY: `plantmodelanthropic${"a2".repeat(12)}`,
  PARALLEL_API_KEY: `planttoolparallel${"p3".repeat(12)}`,
  MONID_API_KEY: `planttoolmonid${"n4".repeat(12)}`,
  DAYTONA_API_KEY: `plantcomputerdaytona${"d5".repeat(12)}`,
  MODAL_TOKEN_SECRET: `plantcomputermodal${"o6".repeat(12)}`,
};
const MCP_HEADER = `plantmcpheader${"h7".repeat(12)}`;
const PLANTED = { ...PLANT, MCP_HEADER };
/** Which planted values `text` holds, by name. */
const found = (text) => Object.entries(PLANTED).filter(([, value]) => text.includes(value)).map(([name]) => name);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** What this process writes to stderr and the console while `t` runs (stdout is the test reporter's, left alone). */
function captureLogs(t) {
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
    for (const [level, fn] of Object.entries(consoled)) console[level] = fn;
  });
  return () => lines.join("\n");
}

/** The store's files as bytes read as text: its tables (sealed columns stay sealed). */
const storeText = (dir) => ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("latin1")).join("\n");

/** A store on a new data directory, its MCP server saved with a planted header (sealed), an agent of `body`, and run-1
 *  launched with `launch`. */
async function storeWith(t, body, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-secret-edge-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.mcp.put({ name: "fake", url: "https://mcp.invalid/mcp", auth: "bearer", tools: [], sealed: sealMcpCredential(SEAL_KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${MCP_HEADER}` } }, "https://mcp.invalid/mcp") });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", ...body } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  assert.ok(storeText(dir).length > 0, "the store's files are there to read");
  return { dir, server, store };
}

/** run-1 run to its end by a runner whose dispatch resolves `harness` with `inner`; its row and its journal's text. */
async function runThrough(t, { server, store }, harness, inner) {
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === harness ? inner(given) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, journal: JSON.stringify(entries) };
}

/** A gateway on loopback that answers OpenAI's Responses API with `text`, recording every request body and header. */
async function responsesGateway(t, text) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body });
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: text },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}

const noComputer = async () => ({ release: async () => {} });

test("a CLI run through the runner: no planted secret reaches the CLI's child environment, the journal, the store or the runner's log", { timeout: 120_000 }, async (t) => {
  const logs = captureLogs(t);
  const gateway = await responsesGateway(t, "Hello from OpenCode.");
  const opened = await storeWith(t, { harness: "opencode", tools: ["read"] }, { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-5" } });
  const childEnv = join(opened.dir, "child-env.json");
  const env = { ...PLANT, AGENT_MODEL_BASE_URL: gateway.origin, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [ENV_DUMP, childEnv, STAND_IN] }) };
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: noComputer };
  const { row, journal } = await runThrough(t, opened, "opencode", (launch) => createAdapterLoop((claim, run) => cliSpec.cliRunSpecFromLaunch(launch, run, deps, claim)));
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.ok(existsSync(childEnv), "the CLI's child ran, and its environment was written down");
  const child = readFileSync(childEnv, "utf8");
  assert.ok(JSON.parse(child).PATH, "the child's environment was read");
  assert.deepEqual(found(child), [], "the CLI's child environment holds no planted secret");
  assert.ok(gateway.seen.length >= 1, "the model request went out through the session's proxy");
  assert.deepEqual(found(journal), [], "the run's journal holds none");
  assert.deepEqual(found(storeText(opened.dir)), [], "the store's files hold none in the clear");
  assert.deepEqual(found(logs()), [], "the runner's log holds none");
});

test("a pi run through the runner whose agent runs `env` in its bash: the shell holds no planted secret, nor do the journal, the model's requests, the store or the runner's log", { timeout: 120_000 }, async (t) => {
  const logs = captureLogs(t);
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => PLANT.ANTHROPIC_API_KEY }, fetch: scriptedOrigin([{ call: "bash", args: { command: "env" } }, { sayLastResult: true }], requests) };
  const launch = { input: { content: "Run env." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  const opened = await storeWith(t, { tools: ["bash"] }, launch);
  const deps = { env: { ...PLANT }, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: noComputer };
  const { row, journal } = await runThrough(t, opened, "pi", (given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)));
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.match(journal, /PATH=/, "the bash ran `env`, and its output is in the journal");
  assert.deepEqual(found(journal), [], "the bash's environment, and the whole journal, hold no planted secret");
  assert.deepEqual(found(JSON.stringify(requests)), [], "the model's requests hold none");
  assert.deepEqual(found(storeText(opened.dir)), [], "the store's files hold none in the clear");
  assert.deepEqual(found(logs()), [], "the runner's log holds none");
});

test("pdf_pages: its programs run with no planted secret in their environment (red on cli-spec, where pdf-pages.ts runs them with this process's whole environment; fixed by untangle/tools-pdf-env 7aa36b1826, main #2016 fb70182f39: helperEnv)", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "secret-edge-pdf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A pdfinfo first on the PATH that writes down its environment, then fails, as a broken PDF would.
  const bin = join(dir, "bin");
  const dump = join(dir, "pdfinfo-env.txt");
  writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4\n%%EOF\n");
  mkdirSync(bin);
  writeFileSync(join(bin, "pdfinfo"), `#!/bin/sh\nenv > '${dump}'\nexit 1\n`);
  chmodSync(join(bin, "pdfinfo"), 0o755);
  // The runner's environment holds its keys (model-route.ts reads its model key from it), as this process's does here.
  const saved = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(PLANT).map((name) => [name, process.env[name]])) };
  Object.assign(process.env, PLANT, { PATH: `${bin}:${process.env.PATH}` });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await pdfPages({ path: "doc.pdf" }, { work: localWorkspace(dir) }).catch(() => undefined);
  assert.ok(existsSync(dump), "pdfinfo ran, and its environment was written down");
  assert.deepEqual(found(readFileSync(dump, "utf8")), [], "pdfinfo's environment holds no planted secret");
});
