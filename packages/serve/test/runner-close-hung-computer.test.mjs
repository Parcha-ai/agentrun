// A runner stopped while its run waits on a computer that never answers (run-tools.ts claimCut): the shutdown's stop
// ends the run's computer call, so the runner closes at once, well inside its close bound (runner.ts runnerCloseBoundMs:
// 40 s), and hands the run back as a shutdown does, never holding it for the whole window and leaving it to its lease.
// The runner is the started process (`agentrun-serve runner`), its run in a process of its own, over the computer
// package's fake docker on PATH (docker-host-fake.mjs): the daemon answers its hello and no file call, so the run's
// start hangs on its first one (its scratch folder). No Docker is reached.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerHost } from "./docker-host-fake.mjs";
import { openSqliteStore } from "../dist/store/index.js";
import { STORE_FILE } from "../dist/store/sqlite/store.js";
import { runnerCloseBoundMs } from "../dist/runner/runner.js";
import { until } from "./runner-support.mjs";

const { fakeAnthropic } = await import("@parcha/agentrun-harness-claude/testing");

const LAUNCHER = fileURLToPath(new URL("../launcher/agentrun-serve", import.meta.url));
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
const SEAL = Buffer.alloc(32, 7).toString("base64");
const READY = /^Runner runner-hung ready: /;

test("SIGTERM while a box-placed run's start waits on a computer that never answers: the runner closes well inside its bound, the run handed back (cut drain), its computer let go", { timeout: 60_000, skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const docker = dockerHost();
  const fake = await fakeAnthropic({ reply: () => ({ text: "Done." }) });
  t.after(() => fake.close());
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-hung-"));
  const config = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-config-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-box", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "box", place: { mode: "sandbox", box: "docker" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
  await server.close();
  // No drain: the close stops the run at once, so what it waits for after is the run's computer call alone.
  const env = { PATH: `${docker.dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: config, XDG_CONFIG_HOME: config, TMPDIR: process.env.TMPDIR ?? tmpdir(), AGENTRUN_SEAL_KEY: SEAL, ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "test-key", AGENTRUN_RUNNER_NAME: "runner-hung" };
  const child = spawn("sh", [LAUNCHER, "runner", "--data", dir, "--loops", "1", "--drain-timeout", "0s"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  });
  const out = [];
  const err = [];
  createInterface({ input: child.stdout }).on("line", (line) => out.push(line));
  createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
  await until(async () => out.some((line) => READY.test(line)), "the runner is ready", 30_000);
  // The run's start is on its computer's first file call, which its daemon never answers.
  await until(async () => docker.fake.unanswered().includes("files.stat"), "the run's start waits on its computer", 30_000)
    .catch((error) => assert.fail(`${error.message}: ${JSON.stringify({ docker: docker.calls(), out: out.slice(-20), err: err.slice(-20) })}`));
  const stoppedAt = Date.now();
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null }, err.join("\n"));
  const tookMs = Date.now() - stoppedAt;
  // Its bound is 40 s (the computer providers' cleanup bound and its margins); a close that waits on the hung call sits
  // all of it out. A quarter of it is far above what the close takes once the call ends (well under a second here).
  assert.ok(tookMs < runnerCloseBoundMs(0) / 4, `closed in ${tookMs} ms, not after its whole ${runnerCloseBoundMs(0)} ms window`);
  // Handed back as a shutdown hands a run back: still running, held by no runner, its claim's attempt cut "drain" and
  // its hand-back recorded; its computer let go (removed, its interval ended), never left to the next claim's fence.
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let row;
  try {
    row = await store.runs.get("run-box");
  } finally {
    await store.close();
  }
  assert.deepEqual({ state: row.state, runner: row.runner }, { state: "running", runner: null }, "handed back, resumable");
  assert.ok(out.includes("Runner runner-hung released run-box (interrupted)"), JSON.stringify(out));
  const db = new DatabaseSync(join(dir, STORE_FILE), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT epoch, cut FROM run_attempts WHERE run_id = 'run-box'").all().map((one) => ({ ...one })), [{ epoch: 1, cut: "drain" }]);
    assert.deepEqual(db.prepare("SELECT runner, epoch FROM hand_backs WHERE run_id = 'run-box'").all().map((one) => ({ ...one })), [{ runner: "runner-hung", epoch: 1 }]);
    const intervals = db.prepare("SELECT kind, ended_at FROM computer_intervals WHERE run_id = 'run-box'").all();
    assert.equal(intervals.length, 1, "one computer, the run's");
    assert.equal(intervals[0].kind, "sandbox");
    assert.equal(typeof intervals[0].ended_at, "number", "its interval ended at the hand-back");
  } finally {
    db.close();
  }
  const made = docker.calls().find((args) => args[0] === "run");
  const name = made[made.indexOf("--name") + 1];
  assert.ok(docker.calls().some((args) => args[0] === "rm" && args.includes(name)), `its container removed: ${JSON.stringify(docker.calls())}`);
});
