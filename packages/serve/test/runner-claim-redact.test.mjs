// A key saved on the server reaches a run as its claim opens it from the store (claim-secrets.ts), never from the runner's
// environment; the runner's one redactor (runner.ts, LoopDeps.redact) holds what the claim opened (redact.ts holdClaimed),
// so it is cut wherever a key of the runner's environment is. A pi run through the runner and its dispatch (the real spec
// builder) calls a host tool (monid's inspect) whose vendor answers with an error that echoes the stored key it was sent,
// and then its provider answers with an error that echoes the stored key too: the run's journal, its row and summary, the
// store's files and the runner's log hold none of it, and the tool's error is in the journal, cut.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { calls as monidCalls } from "./fixtures/faux-monid-echo.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const ECHO_MONID = fileURLToPath(new URL("./fixtures/faux-monid-echo.mjs", import.meta.url));
/** The key saved on the server, sealed in the store: in no environment, built for the test, not a real one. */
const STORED = `storedmonid${"s8".repeat(12)}`;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** What this process writes to stderr and the console while `t` runs. */
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

const storeText = (dir) => ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("latin1")).join("\n");

test("a key a claim opens from the store is cut by the runner's one redactor: a host tool's error and a provider's error that echo it reach no journal entry, row, store file or log", { timeout: 120_000 }, async (t) => {
  const logs = captureLogs(t);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-claim-redact-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await putSealedKey(server, SEAL_KEY, "MONID_API_KEY", STORED);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", tools: ["monid.inspect"], toolSettings: { "monid.inspect": { permission: "allow" } } } });
  const launch = { input: { content: "Inspect it." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();

  // The model calls monid's inspect, then its provider refuses the next request with an error that echoes the stored key.
  const requests = [];
  const first = scriptedOrigin([{ call: "monid_inspect", args: { provider: "faux", endpoint: "/person/enrich" } }], requests);
  const fetch = async (url, init) => requests.length === 0
    ? first(url, init)
    : (requests.push(JSON.parse(String(init.body ?? "{}"))), new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `the key ${STORED} may not call this model` } }), { status: 400, headers: { "content-type": "application/json" } }));
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `routecredential${"r".repeat(12)}` }, fetch, price: () => 0 };
  const env = { AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_MONID: ECHO_MONID };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  await store.flush?.();
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const journal = JSON.stringify(entries);

  assert.ok(monidCalls.includes("/v1/inspect"), `the run's inspect reached monid: ${JSON.stringify(monidCalls)}`);
  assert.ok(requests.length >= 2, `the provider was asked again after the tool, and refused: ${requests.length}`);
  assert.match(journal, /Invalid API key: \[redacted\]/, "the tool's error is in the journal, its key cut");
  assert.ok(!journal.includes(STORED), "the journal holds no stored key");
  assert.ok(!JSON.stringify(row).includes(STORED), `the run's row and summary hold none: ${JSON.stringify(row.summary)}`);
  assert.ok(!storeText(dir).includes(STORED), "the store's files hold none in the clear");
  assert.ok(!logs().includes(STORED), "the runner's log holds none");
});
