// The runner's one redactor (runner.ts `redact`, LoopDeps.redact) is the instance a pi run's model route and its session's
// model proxy use: through the runner and its dispatch (the real spec builder), a provider's error that echoes a value only
// that redactor knows reaches the run's record cut by it, and the route is handed that very instance (the one the runner
// makes of the redactor it is given and hands every loop, redact.ts heldRedactor).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
after(closeOpenSessions);

const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** A value only the runner's redactor knows (a team token a provider echoes), and what that redactor puts in its place. */
const MARK = `team-token-${"m".repeat(12)}-0123456789`;
const CUT_BY_RUNNER = "[cut-by-the-runner]";
const LAUNCH = { input: { content: "Answer." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } };

/** Every file under `dir`, its bytes as text. */
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path).toString("latin1") });
  }
  return out;
}

test("the runner's one redactor is the instance a pi run's route and model proxy use: a provider's error echoing a value only it knows reaches the run's record cut by it", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-redact-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await server.flush?.();

  const redact = (text) => text.split(MARK).join(CUT_BY_RUNNER);
  const routed = [];
  let asked = 0;
  const upstream = async () => {
    asked += 1;
    return new Response(JSON.stringify({ type: "error", error: { type: "permission_error", message: `the team token ${MARK} has no access to this model` } }), { status: 403, headers: { "content-type": "application/json" } });
  };
  const routeOf = async (model, env, tier, wires, given, redactor) => {
    routed.push(redactor);
    return { model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"r".repeat(8)}` }, fetch: upstream, price: () => 0 };
  };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf, computerForClaim: async () => ({ release: async () => {} }) };
  const dispatch = createDispatchLoop({ launchOf: async () => ({ body: LAUNCH }), resolve: resolveRunnerLoop(deps) });
  // The instance the runner hands each loop (LoopDeps.redact): the one it made of `redact`, able to hold what a claim opens.
  const handed = [];
  const createLoop = (loopDeps) => (handed.push(loopDeps.redact), dispatch(loopDeps));
  runner = startRunner({ store, createLoop, name: "runner-a", redact, ...TIMING });
  for (const end = Date.now() + 30_000; ; ) {
    const row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    assert.ok(Date.now() < end, `the run did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(asked >= 1, "the provider was asked, and refused");
  assert.ok(handed.length >= 1 && handed.every((given) => given === handed[0]), "every loop was handed the one instance");
  assert.equal(handed[0](MARK), CUT_BY_RUNNER, "the instance cuts as the runner's redactor does");
  assert.ok(routed.length >= 1 && routed.every((given) => given === handed[0]), "the route was handed that very instance");
  await store.flush?.();
  const files = filesUnder(dir);
  assert.deepEqual(files.filter((file) => file.text.includes(MARK)).map((file) => file.path.slice(dir.length)), [], "no file of the run's store holds the value");
  assert.ok(files.some((file) => file.text.includes(CUT_BY_RUNNER)), "the error pi kept was cut by the runner's redactor in the session's proxy");
});
