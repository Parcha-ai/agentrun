// A run's own process (run-child.ts) where each run is a user of its own: the server's data folder is traverse-only to
// it (0711, run-child-host.ts layRunFolders) and the machine's id file (claude-login.ts machineId) is the server's user's
// alone (0600). Its claim of a claude-agent run on AgentRun's own Claude Code login folder reads and makes neither:
// whether the claim goes on the login, and its token when it does, are its runner's answer (held.ts claudeLogin). The
// run's user is stood in for by this test's own, with the data folder and the id file shut to it as the run's user
// finds them; root reads every file, so the test does not run as root.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { setHeld } = await import("../dist/runner/held.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { MACHINE_ID_FILE, settingFor } = await import("../dist/claude-login.js");
const { runFolder, recordingsFolder, scratchFolder } = await import("../dist/workspace/paths.js");

const ROOT = process.getuid?.() === 0 && "root reads every file";

/** A claim of a claude-agent run on AgentRun's own login folder, turned on for this machine as the owner's turn-on
 *  saves it, built as a run's own process builds it: no seal key, its runner asked over `held` (a stand-in that answers
 *  `claudeLogin` with `handed()` and every other ask with nothing), the data folder shut as the run's user finds it.
 *  Resolves to the spec; rejects as the claim fails. `asked`: what the process asked its runner, in order. */
async function childClaim(t, handed, asked) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "login-child-store-"));
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "login-child-data-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let built;
  let harness;
  t.after(async () => {
    setHeld(undefined);
    await built?.release?.().catch(() => {});
    await harness?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    chmodSync(data, 0o700);
    chmodSync(join(data, MACHINE_ID_FILE), 0o600);
    rmSync(data, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  // The server's turn-on: it makes the machine's id in the data folder (0600, the server's user's).
  await server.settings.put("claude_login", settingFor("agentrun", data));
  assert.ok(readdirSync(data).includes(MACHINE_ID_FILE), "the server made the machine's id at its turn-on");
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "claude-agent", model: "anthropic/claude-haiku-5-5", tools: ["read"] } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: "claude-agent" };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  // The run's folders as its runner lays them before the process starts; then the data folder traverse-only to the
  // run's user and the id file none of its own.
  for (const folder of [runFolder(data, "agent-1", "run-1"), recordingsFolder(data, "agent-1", "run-1"), join(scratchFolder(data, "agent-1", "run-1"), "tmp")]) mkdirSync(folder, { recursive: true });
  chmodSync(join(data, MACHINE_ID_FILE), 0o000);
  chmodSync(data, 0o111);
  const answers = { claudeLogin: async () => (asked.push("claudeLogin"), handed()) };
  setHeld(new Proxy(answers, { get: (target, name) => (name in target ? target[name] : name === "then" || typeof name !== "string" ? undefined : async () => void asked.push(name)) }));
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const deps = { env: { PATH: process.env.PATH }, data, journal: (c) => store.journal(c), store, sealKey: undefined, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }), installSettled: async () => "installed" };
  built = await cliRunSpecFromLaunch(launch, { harness, registry, setModels: (given) => (models = given) }, deps, claim);
  return built;
}

test("a run's own process, where each run is a user of its own, reads and makes no machine id in the server's data folder: its claim on AgentRun's own login asks its runner, and reads the token the runner hands before the run", { skip: ROOT }, async (t) => {
  const asked = [];
  const READ = "the runner's reader was asked for the login's token";
  await assert.rejects(childClaim(t, () => ({ token: async () => { throw new Error(READ); }, refused: async () => {} }), asked), (error) => {
    assert.equal(error.message, READ, `the claim reached the token its runner hands, never the server's machine-id file: ${error.stack}`);
    return true;
  });
  assert.deepEqual(asked.filter((name) => name === "claudeLogin"), ["claudeLogin"], "the runner was asked once whether this claim goes on the login");
});

test("a run's own process whose runner hands it no login (a claim the runner does not put on it) is not on the login: it reads no token and no machine id, and goes on to build its adapter", { skip: ROOT }, async (t) => {
  const asked = [];
  await assert.rejects(childClaim(t, () => undefined, asked), (error) => {
    assert.doesNotMatch(error.message, /EACCES|machine-id/, `the server's machine-id file is never read or made here: ${error.stack}`);
    // Past its login and its model choice to its adapter, which finds no install of the CLI here (the test lays none).
    assert.match(error.message, /^Claude Code \(\S+\) is not installed in /, `the runner's answer (no login) is the decision, and the claim goes on without one: ${error.stack}`);
    return true;
  });
  assert.ok(asked.includes("claudeLogin"), `the runner was asked: ${asked.join(", ")}`);
});
