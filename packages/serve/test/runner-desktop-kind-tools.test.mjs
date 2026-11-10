// A desktop computer brings its kind's tools to a run on the runner. An agent names its computer (definition.computer
// {kind: "desktop", provider}), never the desktop's tools (definition.tools refuses them), so the run's spec binds,
// beside what the revision grants, the tools the CLAIMED computer brings by its kind: desktop_screen, desktop_input and
// computer_request_handoff, by the kernel registry's own list (DESKTOP_TOOL_DEFS), each once. They go through the run's
// one gate under the kind's settings key (`desktop`), so a deny refuses them in its words (naming desktop). A run with no computer gets
// none of them.
// The pi spec (adapter-run-spec.ts) through specFor, the CLI spec (cli-run-spec.ts) through the runner on Codex's
// stand-in; the computer is --faux's desktop through the runner's one composer (computerDepsFrom), whose screen.shot is
// a grey screen. Loopback only: no provider, no key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { specFor, toolNames } from "./runner-spec-support.mjs";

const { DESKTOP_TOOL_DEFS } = await import("../../run-adapters/dist/kernel/registry/index.js");
const { computerDepsFrom } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { deniedText } = await import("../dist/tool-gate.js");
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CODEX_STANDIN_ENV } = await import("../dist/adapters.js");

/** The desktop's tools, as the kernel's registry lists them: imported, never retyped. */
const DESKTOP = DESKTOP_TOOL_DEFS.map((def) => def.name);
const FAUX_DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const DENY_DESKTOP = { desktop: { permission: "deny" } };
const CLICK = { actions: [{ type: "click", at: [10, 10] }] };

/** The runner's one composer over --faux's computers: a faux desktop for a claim whose agent names one. */
const fauxComposer = ({ store, sealKey }) => computerDepsFrom({ env: {}, store, sealKey, faux: fauxComputers({ viewerBase: "http://127.0.0.1:9" }) });
const callOf = (spec, name) => spec.session.tools.find((tool) => tool.name === name);
const ctx = (callId) => ({ callId, signal: new AbortController().signal, attempt: 0 });

test("pi: a run of an agent whose computer is a desktop is handed desktop_screen, desktop_input and computer_request_handoff, each once, beside what it was granted; a desktop_screen call runs and answers a screenshot", async (t) => {
  assert.deepEqual([...DESKTOP].sort(), ["computer_request_handoff", "desktop_input", "desktop_screen"], "the registry's desktop tools");
  // desktop_screen is granted too (the store keeps a body the API would refuse): it is bound once.
  const { spec } = await specFor(t, { body: { tools: ["read", "desktop_screen"], computer: FAUX_DESKTOP }, computer: fauxComposer });
  const names = toolNames(spec);
  for (const name of DESKTOP) assert.equal(names.filter((given) => given === name).length, 1, `${name} is handed once: ${JSON.stringify(names)}`);
  assert.ok(names.includes("read"), "what the revision grants is still handed");
  assert.equal(await spec.gate({ callId: "g1", tool: "desktop_screen", args: {} }), "allow", "desktop is allowed by default");
  const shot = await callOf(spec, "desktop_screen").call({}, ctx("c1"));
  assert.notEqual(shot.isError, true, `the screenshot ran: ${shot.text}`);
  assert.ok(shot.images?.length === 1, `it answers the screen as an image: ${JSON.stringify({ ...shot, images: shot.images?.length })}`);
  const input = await callOf(spec, "desktop_input").call(CLICK, ctx("c2"));
  assert.notEqual(input.isError, true, `the click ran: ${input.text}`);
});

test("pi: a run with no computer is handed none of the desktop's tools", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read"] }, computer: fauxComposer });
  const names = toolNames(spec);
  assert.deepEqual(DESKTOP.filter((name) => names.includes(name)), [], `no desktop tool: ${JSON.stringify(names)}`);
});

test("pi: desktop set to deny on this server refuses desktop_input and desktop_screen at the run's gate, in the deny words naming desktop's setting", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read"], computer: FAUX_DESKTOP }, settings: DENY_DESKTOP, computer: fauxComposer });
  assert.ok(toolNames(spec).includes("desktop_input"), "the tool is handed, and the gate holds it");
  for (const [tool, args] of [["desktop_input", CLICK], ["desktop_screen", {}]]) {
    const given = await spec.gate({ callId: `d-${tool}`, tool, args });
    // The gate asks a kind's tool as its kind (tool-gate.ts askedAs), so its words name the setting the owner set: desktop.
    assert.deepEqual(given, { deny: deniedText("desktop") }, `${tool} is refused in desktop's deny words`);
  }
});

/** A loopback gateway answering OpenAI's Responses API with `text` (SSE). */
async function gateway(t, text) {
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _chunk of req) void _chunk;
    const events = [{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Every path under `dir` whose last segment is `name`. */
function findAll(dir, name, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === name) found.push(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) findAll(path, name, found);
  }
  return found;
}

/** A codex run on the runner path, on Codex's stand-in, its agent's computer --faux's desktop, whose model calls `tool`
 *  with `args` (its first message is the stand-in's call). `settings`: the server's tool settings. Returns the tools
 *  Codex was handed and the call's answer from Codex's session record (undefined when none came within 15 s). */
async function codexCall(t, tool, args, settings) {
  const was = process.env.AGENTRUN_CODEX_STANDIN;
  process.env.AGENTRUN_CODEX_STANDIN = "1";
  t.after(() => (was === undefined ? delete process.env.AGENTRUN_CODEX_STANDIN : (process.env.AGENTRUN_CODEX_STANDIN = was)));
  const origin = await gateway(t, "Codex answered.");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-desktop-tools-"));
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Use the desktop.", harness: "codex", tools: ["read"], computer: FAUX_DESKTOP } });
  if (settings) await server.settings.put("tool-settings", settings);
  const launch = { input: { content: `call ${tool} ${JSON.stringify(args)}` }, title: "t", place: { mode: "runner" }, harness: "codex", model: { provider: "openai", modelId: "gpt-test" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const sealKey = Buffer.alloc(32, 7);
  const env = {
    [CODEX_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  };
  const log = [];
  const { computerForClaim, computerDeps } = fauxComposer({ store, sealKey });
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey, routeOf: async () => assert.fail("a CLI run takes no pi route"), log: (line) => log.push(line), computerForClaim, computerDeps };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === "codex" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const end = Date.now() + 90_000;
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "parked", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() > end) throw new Error(`the run did not end: ${JSON.stringify(row)}; log ${JSON.stringify(log)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(["ended", "parked"].includes(row.state), `the run did its turn: ${JSON.stringify(row)}; log ${JSON.stringify(log)}`);
  const homes = findAll(dir, "codex-home");
  assert.equal(homes.length, 1, `one CODEX_HOME for the run: ${JSON.stringify(homes)}`);
  const rollouts = readdirSync(join(homes[0], "sessions"), { recursive: true }).map(String).filter((path) => path.endsWith(".jsonl"));
  assert.ok(rollouts.length >= 1, "Codex recorded its session");
  const record = () => readFileSync(join(homes[0], "sessions", rollouts[0]), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const outputs = () => record().filter((line) => line.payload?.type === "function_call_output").map((line) => String(line.payload.output));
  const by = Date.now() + 15_000;
  while (!outputs().length && Date.now() < by) await new Promise((resolve) => setTimeout(resolve, 50));
  const lines = record();
  return { handed: (lines[0].payload.dynamic_tools ?? []).map((given) => given.name), calls: lines.filter((line) => line.payload?.type === "function_call").map((line) => line.payload.name), answer: outputs()[0] };
}

test("codex: a run of an agent whose computer is a desktop is handed desktop_screen, desktop_input and computer_request_handoff, and the model's desktop_screen call runs", { timeout: 120_000 }, async (t) => {
  const { handed, calls, answer } = await codexCall(t, "desktop_screen", {});
  for (const name of DESKTOP) assert.ok(handed.includes(name), `${name} is among Codex's tools: ${JSON.stringify(handed)}`);
  assert.deepEqual(calls, ["desktop_screen"], "the model's call reached Codex");
  assert.ok(answer !== undefined, "the call answered");
  assert.doesNotMatch(answer, /not available|Permission denied|error/i, `the screenshot ran: ${answer}`);
});

test("codex: desktop set to deny on this server refuses the model's desktop_input call in the deny words naming desktop's setting", { timeout: 120_000 }, async (t) => {
  const { handed, answer } = await codexCall(t, "desktop_input", CLICK, DENY_DESKTOP);
  assert.ok(handed.includes("desktop_input"), `desktop_input is handed, and the gate holds it: ${JSON.stringify(handed)}`);
  assert.ok(answer?.includes(deniedText("desktop")), `refused in desktop's deny words: ${answer}`);
});
