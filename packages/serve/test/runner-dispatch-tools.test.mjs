// pi's tools end to end through the runner's DISPATCH (harness-loops.ts resolveRunnerLoop under dispatch.ts
// createDispatchLoop under runner.ts startRunner), on a real store, with the model's upstream a recording gateway behind
// deps.routeOf: table-driven over WIRES. A pi run's first request offers the model, by name, pi's own tools as the
// session's builtins: the hands (the kernel registry's, hostToolDefs, bound over the run's workspace and its sandbox, a
// fake computer over the run's folder whose processes are real) and a granted host tool (web_fetch). The upstream calls
// one, and the run gets its result: the next request carries it. A run with no computer (a runner place, Mode 1) is
// offered no bash family at all, its folder being one of this server's own: a model's bash call anyway answers that the
// tool is not available and runs nothing, and a file tool's read of a file of the server's data outside the run's
// folder is refused.
// Each wire's session policy (pi.ts policyFor: claude-agent's on Messages, codex's on Responses) admits these tools by
// name and drops every other definition, so a policy that admitted none would offer the model nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { sandboxForClaim } from "./workspace-fake-processes.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { WIRES } = await import("../dist/wires.js");
const { hostToolDefs } = await import("../../run-adapters/dist/kernel/registry/index.js");
const { WEB_FETCH_TOOL } = await import("../dist/web-fetch.js");
after(closeOpenSessions);

const KEY = `not-a-secret-${"d"}`;
const SAID = "dispatched-tools-ok";
/** The hands, as the kernel's registry defines them for a run with a computer (the runner binds the granted ones to the
 *  run's workspace and computer, runTools.hostTools): imported, never retyped, so a hand renamed or added is in the
 *  list. With no computer, the hands with no shell. */
const HANDS = hostToolDefs({ maxExecS: 60, shell: "computer" }).map((def) => def.name);
const NO_SHELL_HANDS = hostToolDefs({ maxExecS: 60, shell: "none" }).map((def) => def.name);
/** A granted host tool that is not a hand, one the runner binds (adapter-run-spec.ts bindNonHandTools): web_fetch. */
const HOST_TOOL = WEB_FETCH_TOOL;
/** The agent is granted every hand and the host tool: the first request offers exactly these, by name. */
const GRANTED = [...HANDS, HOST_TOOL];
const OFFERED = [...GRANTED].sort();

/** On each wire, a source whose route speaks it to the gateway, and where its requests land. */
const SOURCES = {
  "anthropic-messages": { model: "anthropic/claude-sonnet-4-5", env: (url) => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: url }), path: "/v1/messages", launched: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
  "openai-responses": { model: undefined, env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "team-model", AGENT_MODEL_PRICE: "1,1" }), path: "/v1/responses" },
};

/** The tool names a request body offers, on its path's API. */
const toolsOf = (request) => (request.body?.tools ?? []).map((tool) => tool.name ?? tool.function?.name).sort();

test("the table names every wire", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), Object.keys(WIRES).sort());
});

for (const [wire, source] of Object.entries(SOURCES)) {
  test(`${wire}: a pi run through the dispatch offers the hands and its granted host tool by name, and the model's call of one returns its result to the run`, { timeout: 120_000 }, async (t) => {
    const gateway = await startFauxGateway({
      call: (request) => (JSON.stringify(request.body ?? {}).includes(SAID) ? undefined : { name: "bash", input: { command: `echo ${SAID}` } }),
      usage: { input: 10, output: 2 },
    });
    t.after(() => gateway.close());
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-dispatch-tools-"));
    const server = await openSqliteStore({ dataDir: dir, role: "server" });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    t.after(async () => {
      await store.close().catch(() => {});
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Run the command.", tools: GRANTED } });
    await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Run it." }, title: "t", place: { mode: "runner" }, harness: "pi", ...(source.launched ? { model: source.launched } : {}) } });
    const asked = [];
    const sandbox = sandboxForClaim();
    const deps = {
      env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7),
      computerForClaim: sandbox.forClaim,
      // The route the runner gives the run, on the wires pi asks for: the source's own, at the recording gateway.
      routeOf: async (_model, _env, tier, wires) => (asked.push(wires), routeOf(source.model, source.env(gateway.url), tier, wires)),
    };
    const runner = startRunner({
      store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) }),
    });
    t.after(() => runner.close().catch(() => {}));
    const started = Date.now();
    let row;
    for (;;) {
      row = await server.runs.get("run-1");
      if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
      if (Date.now() - started > 90_000) assert.fail(`the run never ended: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.ok(asked.length >= 1 && asked.every((wires) => wires.includes(wire)), `the route was asked on ${wire}: ${JSON.stringify(asked)}`);
    assert.ok(gateway.requests.length >= 2 && gateway.requests.every((request) => request.path === source.path), JSON.stringify(gateway.requests.map((request) => request.path)));
    assert.deepEqual(toolsOf(gateway.requests[0]), OFFERED, "the first request offers the hands and the granted host tool, by name");
    assert.ok(JSON.stringify(gateway.requests.at(-1).body).includes(SAID), "the bash call's result went back to the model");
    assert.ok(sandbox.made.length === 1 && sandbox.made[0].methods().includes("process.start"), "the bash ran in the run's sandbox");
  });
}

/** A Messages request's tool results, in order: [text, isError]. */
const resultsOf = (request) => (request.body?.messages ?? [])
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((block) => block.type === "tool_result")
  .map((block) => [typeof block.content === "string" ? block.content : (block.content ?? []).map((part) => part.text ?? "").join(""), block.is_error === true]);

test("a pi run with no computer (a runner place, Mode 1) is offered no bash family: a model's bash call answers that it is not available and runs nothing, and a read of the server's data outside the run's folder is refused", { timeout: 120_000 }, async (t) => {
  const source = SOURCES["anthropic-messages"];
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-dispatch-no-shell-"));
  // A file of the server's own data, beside its store: what a host shell, or a file tool unconfined, would read.
  const TOKEN = "fake-test-key";
  const tokenPath = join(dir, ".token");
  writeFileSync(tokenPath, TOKEN);
  // The model calls bash (cat the server's file), then read (the same file), then answers.
  const gateway = await startFauxGateway({
    call: (request) => [{ name: "bash", input: { command: `cat ${tokenPath}; echo ran-on-the-server` } }, { name: "read", input: { path: tokenPath } }][resultsOf(request).length],
    usage: { input: 10, output: 2 },
  });
  t.after(() => gateway.close());
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // Granted every hand a computer would give, and web_fetch.
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Run the command.", tools: GRANTED } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Run it." }, title: "t", place: { mode: "runner" }, harness: "pi", model: source.launched } });
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7),
    computerForClaim: async () => ({ release: async () => {} }),
    routeOf: async (_model, _env, tier, wires) => routeOf(source.model, source.env(gateway.url), tier, wires),
  };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const started = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - started > 90_000) assert.fail(`the run never ended: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(toolsOf(gateway.requests[0]), [...NO_SHELL_HANDS, HOST_TOOL].sort(), "the first request offers the file tools and web_fetch: no bash family");
  const [bash, read] = resultsOf(gateway.requests.at(-1));
  assert.ok(bash && read, `both calls answered: ${JSON.stringify(resultsOf(gateway.requests.at(-1)))}`);
  assert.match(bash[0], /bash is not available/i, "the bash call answers that the tool is not available");
  assert.equal(bash[1], true);
  assert.equal(read[1], true, `the read outside the run's folder is refused: ${read[0]}`);
  const said = JSON.stringify(gateway.requests.map((request) => request.body));
  assert.ok(!said.includes(TOKEN), "the server's file reached the model through neither call");
  assert.ok(!said.includes("ran-on-the-server\n"), "no command ran");
});
