// A CLI run on a server whose secrets came over its launcher's pipe: the runner's run environment (runEnv) holds each
// secret readable by name and never enumerable. A CLI run built from it (cli-run-spec.ts, cliRunSpecFromLaunch) must
// keep it so: its model route reads the key by name, so its requests carry it, while a program the run spawns sees no
// key. A spread of the run environment dropped every secret, and a Claude Code
// or Codex run sent its requests with no key (#2165).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const RUN = "run-1";
const KEY = `not-a-secret-${"gateway-key"}`;
const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A gateway on loopback that answers OpenAI's Responses API, recording each request's authorization header. */
async function gateway(t) {
  const auth = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    auth.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null });
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: "Hello." },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { auth, origin: `http://127.0.0.1:${server.address().port}` };
}

test("a CLI run whose model key the runner holds only by name (as the launcher hands it) sends that key on its requests, while the program it starts sees no key", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cli-run-env-"));
  const gw = await gateway(t);
  // The CLI's process, through a wrapper that writes the names in its environment before it starts the stand-in.
  const seen = join(dir, "spawned-env.json");
  const wrapper = join(dir, "spawned.mjs");
  writeFileSync(wrapper, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));\nawait import(${JSON.stringify(STAND_IN)});\n`);
  // The run environment as runEnv gives it (runner/main.ts): the gateway's address an ordinary variable, its key a
  // property readable by name that never enumerates.
  const env = { AGENT_MODEL_BASE_URL: gw.origin, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [wrapper] }), PATH: process.env.PATH };
  Object.defineProperty(env, "AGENT_MODEL_API_KEY", { value: KEY, enumerable: false, writable: false, configurable: false });
  assert.ok(!Object.keys(env).includes("AGENT_MODEL_API_KEY"), "the run environment never enumerates the key");

  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly.", harness: "opencode", tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-5" } } });
  await server.flush?.();
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "opencode" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  // Its model requests (POSTs): a stand-in's own startup GETs, which carry no credential and may or may not land before
  // the run ends, are not model requests.
  const asked = gw.auth.filter((request) => request.method === "POST");
  assert.ok(asked.length > 0, `the run asked its model: ${JSON.stringify(gw.auth)}`);
  assert.ok(asked.every((request) => request.auth === `Bearer ${KEY}`), `every model request carried the key: ${JSON.stringify(gw.auth)}`);
  const names = JSON.parse(readFileSync(seen, "utf8"));
  assert.ok(names.length > 0 && !names.includes("AGENT_MODEL_API_KEY"), `the program the run started sees no key: ${JSON.stringify(names)}`);
});
