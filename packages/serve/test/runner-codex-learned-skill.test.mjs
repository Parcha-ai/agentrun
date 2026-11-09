// A skill an agent learned reaches a codex run on the RUNNER path as Codex's own skill: the runner claims the run, the CLI
// spec builder (cliRunSpecFromLaunch) lays the run's learning seed at the claim (runner/learning-seed.ts), and the
// learned skill is handed to the codex adapter in its native skill list. Codex then finds it in its session's
// CODEX_HOME/skills (where it lists a user's skills), read_skill_file is among its tools, and the model's call of it
// reaches Codex. learned-skill-native.test.mjs proves the same, and the read's answer, through serve's own start (main's
// pinSeed); this one never goes through it. The answer is not checked here: on the runner path the run's gate
// (adapterRunGate) asks for read_skill_file, so the run parks for an approval before the read answers (a gap of the
// gate's, named to its owner). On Codex's stand-in (no Codex binary) and a loopback gateway: no network, no key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CODEX_STANDIN_ENV } = await import("../dist/adapters.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { servedSkill } = await import("../dist/learn/skills.js");
const { seedOf } = await import("../dist/learning.js");

const AGENT = "agent-1";
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const GATEWAY_KEY = `not-a-secret-${"gateway"}`;
const NAME = "status-report-format";
const RULE = "Start every report with STATUS: OK or STATUS: FAIL.";
const SKILL = `---\nname: ${NAME}\ndescription: Use for every report to the user\n---\n${RULE}\n`;
const READ = { skill: NAME, path: "SKILL.md" };
const noSetpriv = !existsSync("/usr/bin/setpriv") && "no setpriv here";

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

/** process.env.AGENTRUN_CODEX_STANDIN set for test `t` (the codex package takes a stand-in only under it). */
function standInGuard(t) {
  const was = process.env.AGENTRUN_CODEX_STANDIN;
  process.env.AGENTRUN_CODEX_STANDIN = "1";
  t.after(() => (was === undefined ? delete process.env.AGENTRUN_CODEX_STANDIN : (process.env.AGENTRUN_CODEX_STANDIN = was)));
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

test("on the runner path, a codex run gets the skill its agent learned as Codex's own: in its session's CODEX_HOME/skills, read_skill_file among its tools, and the model's read of it reaches Codex", { timeout: 120_000, skip: noSetpriv }, async (t) => {
  standInGuard(t);
  const origin = await gateway(t, "Codex answered.");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-codex-learned-"));
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

  // The learned skill on the agent's learning folder's main: the seed the run's learning start pins.
  const folder = learningWorkspace({ mode: "local", data: dir, agentId: AGENT });
  try {
    const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file: `skills/${NAME}/SKILL.md`, text: SKILL, ifMatch: null });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
  const seed = (await seedOf(dir, AGENT)).sha;

  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer the question.", harness: "codex", tools: ["read"], learning: true } });
  const launch = { input: { content: `call read_skill_file ${JSON.stringify(READ)}` }, title: "t", place: { mode: "runner" }, harness: "codex", model: { provider: "openai", modelId: "gpt-test" }, learning: { given: [], seed, section: "", seedNotes: 0 } };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await server.flush?.();

  const env = {
    [CODEX_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: GATEWAY_KEY,
    AGENT_MODEL_PRICE: "1,2,0.5",
  };
  const log = [];
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), log: (line) => log.push(line), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store,
    name: "runner-a",
    ...CONFORMANCE_TIMING,
    leaseMs: 30_000,
    stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === "codex" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const end = Date.now() + 90_000;
  let row;
  for (;;) {
    row = await server.runs.get(RUN);
    if (["ended", "parked", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() > end) throw new Error(`the run did not end: ${JSON.stringify(row)}; log ${JSON.stringify(log)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(["ended", "parked"].includes(row.state), `the run did its turn (ended, or parked for the next message): ${JSON.stringify(row)}; log ${JSON.stringify(log)}`);

  // Codex's own home for the session: the learned skill where Codex lists a user's skills.
  const homes = findAll(dir, "codex-home");
  assert.equal(homes.length, 1, `one CODEX_HOME for the run: ${JSON.stringify(homes)}`);
  const listed = join(homes[0], "skills", NAME, "SKILL.md");
  assert.equal(existsSync(listed) ? readFileSync(listed, "utf8") : null, servedSkill(SKILL), "Codex finds the learned skill where it lists a user's skills");
  // Codex's session record: read_skill_file among its tools, and the model's call of it made.
  const rollouts = readdirSync(join(homes[0], "sessions"), { recursive: true }).map(String).filter((path) => path.endsWith(".jsonl"));
  assert.ok(rollouts.length >= 1, "Codex recorded its session");
  const lines = readFileSync(join(homes[0], "sessions", rollouts[0]), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok((lines[0].payload.dynamic_tools ?? []).some((tool) => tool.name === "read_skill_file"), `read_skill_file is among Codex's tools: ${JSON.stringify((lines[0].payload.dynamic_tools ?? []).map((tool) => tool.name))}`);
  const calls = lines.filter((line) => line.payload?.type === "function_call").map((line) => [line.payload.name, JSON.parse(line.payload.arguments)]);
  assert.deepEqual(calls, [["read_skill_file", READ]], "the model's read of the learned skill reached Codex");
});
