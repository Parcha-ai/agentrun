// A run's process SIGKILLed mid-turn, while its Claude CLI is alive with a model request out, leaves nothing of itself
// running and sends nothing more: on the real pinned Agent SDK and Claude CLI, through serve, against a fake Anthropic
// endpoint on loopback (no key, no network). The CLI starts under the run's prefix (setpriv --pdeathsig KILL,
// run-adapters host/parent-death.ts), so the kernel kills it the moment the run's process dies; the server then takes the
// run back and opens it again on a new process. Read by pid and /proc: every process under the killed one, the CLI
// among them, is gone within 2 s of the kill; the CLI's only way to the provider, the model proxy in its environment,
// has no listener of the old tree left (read by the listening socket's owner, never the port number, which the kernel
// may give to another process at once); and no request reaches the provider from the old process after the kill (each request is
// attributed to the process that held the run when it came). claude-run.test.mjs's kill test checks the CLI only once
// the run has completed; this one bounds the whole old process tree from the kill.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, runRecordOf, serve } from "./support.mjs";

/** A key for the fake endpoint: no real one. */
const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
/** How long the old process tree may outlive the kill. */
const GONE_MS = 2_000;

// As claude-run.test.mjs: the pinned CLI is a dev dependency here, so only the platform and setpriv can skip it.
const skip = process.platform !== "linux" ? "needs /proc" : !existsSync("/usr/bin/setpriv") ? "no setpriv here" : false;

/** Every process under `root` (not `root` itself), by walking each one's children in /proc. */
async function under(root) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(() => "")).split(" ").filter(Boolean)) {
        out.push(Number(child));
        queue.push(Number(child));
      }
    }
  }
  return out;
}
/** A process's start time (its /proc stat's 22nd field), so a pid the kernel gives again is never taken for the old one. */
const startOf = async (pid) => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] : undefined;
};
/** Whether the very process `p` (pid and start time) still runs: a zombie does not. */
const runs = async (p) => processAlive(p.pid) && (await startOf(p.pid)) === p.start;
const argvOf = async (pid) => (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
const isClaude = (argv) => argv.some((arg) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(arg));
/** A process's environment, as its /proc file has it. */
const envOf = async (pid) => Object.fromEntries((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
/** Whether a TCP connection to `port` on loopback is taken (true) or refused (false). */
const accepts = (port) => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});
/** The socket inodes listening on TCP `port` (IPv4 and IPv6), from /proc/net/tcp and tcp6 (state 0A is LISTEN). */
async function listeningOn(port) {
  const inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(table, "utf8").catch(() => "")).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      if (Number.parseInt(fields[1].slice(fields[1].lastIndexOf(":") + 1), 16) === port) inodes.add(fields[9]);
    }
  }
  return inodes;
}
/** The processes (pid and start time) holding any of `inodes` open, by each readable process's /proc/<pid>/fd. */
async function holdersOf(inodes) {
  const out = [];
  if (!inodes.size) return out;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    for (const fd of await readdir(`/proc/${name}/fd`).catch(() => [])) {
      const target = await readlink(`/proc/${name}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) {
        out.push({ pid: Number(name), start: await startOf(Number(name)) });
        break;
      }
    }
  }
  return out;
}
/** The processes of `old` (pid and start time) that hold a listener on `port`: a port the kernel gave to another process
 *  since is never taken for the old one. */
const oldListeners = async (port, old) => (await holdersOf(await listeningOn(port))).filter((h) => old.some((p) => p.pid === h.pid && p.start === h.start));

test("a run's process SIGKILLed while its Claude CLI has a request out: every process under it is gone within 2 s, no listener of the old tree is left on the CLI's proxy port, no request reaches the provider from it after the kill, and the run completes on its next process", { timeout: 240_000, skip }, async (t) => {
  // The first request is held open until the test ends; every later one is answered. Each request is filed with the
  // process holding the run as it came: the run's record names its holder before that process starts its CLI.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  let data;
  let runId;
  const came = [];
  let first = true;
  const fake = await fakeAnthropic({
    reply: () => {
      came.push({ at: Date.now(), holder: runId ? runRecordOf(data, runId).holder?.pid : undefined });
      if (!first) return { text: "Claude answered." };
      first = false;
      return { hold: held, then: { text: "Claude answered." } };
    },
  });
  t.after(() => fake.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` });
  const served = await serve(t, { faux: undefined });
  const { api } = served;
  data = served.data;
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);

  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  runId = run.body.run_id;
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 600, "a model request reaches the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // The old process and everything under it, read before the kill: the CLI is among them, alive, its request held.
  const old = runRecordOf(data, runId).holder.pid;
  const tree = await under(old);
  const named = await Promise.all(tree.map(async (pid) => ({ pid, start: await startOf(pid), argv: await argvOf(pid) })));
  const cli = named.find((p) => isClaude(p.argv));
  assert.ok(cli && (await runs(cli)), `the Claude CLI runs under the run's process ${old}: ${JSON.stringify(named.map((p) => [p.pid, p.argv.slice(0, 3)]))}`);
  t.after(async () => { for (const p of named) if (await runs(p)) try { process.kill(p.pid, "SIGKILL"); } catch {} });
  const proxy = new URL((await envOf(cli.pid)).ANTHROPIC_BASE_URL);
  assert.equal(proxy.hostname, "127.0.0.1", `the CLI's model endpoint is the run's proxy on loopback: ${proxy}`);
  const port = Number(proxy.port);
  // The old tree as the listener check reads it: the run's process (which holds the proxy) and everything under it.
  const oldTree = [{ pid: old, start: await startOf(old) }, ...named];
  assert.ok(await accepts(port), "the proxy takes connections while the run's process lives");
  assert.ok((await oldListeners(port, oldTree)).length > 0, `the proxy's listener on ${port} is the old tree's while it lives: the check sees it`);

  const killed = Date.now();
  process.kill(old, "SIGKILL");
  // Bounded from the kill: every process that was under the run's process, the CLI included, is gone (a zombie, not yet
  // reaped, counts as gone).
  const stillRunning = async () => (await Promise.all(named.map(async (p) => ((await runs(p)) ? p : undefined)))).filter(Boolean);
  for (;;) {
    const left = await stillRunning();
    if (!left.length) break;
    assert.ok(Date.now() - killed < GONE_MS, `within ${GONE_MS} ms of the kill nothing under the run's process ${old} runs; left: ${JSON.stringify(left.map((p) => [p.pid, p.argv.slice(0, 3)]))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await runs(cli), false, `the old CLI ${cli.pid} is gone`);
  // The CLI's way to the provider, the proxy, is gone with it: no listener on its port belongs to the old tree. Read by
  // owner, never by the port alone, which the kernel may give to any process once it is free (another test's server, the
  // run's next process).
  for (;;) {
    const holding = await oldListeners(port, oldTree);
    if (!holding.length) break;
    assert.ok(Date.now() - killed < GONE_MS, `within ${GONE_MS} ms of the kill no listener on the proxy's port ${port} is the old tree's; held by ${JSON.stringify(holding)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The check keys on the owner: this process takes the freed port, and the port answers, but nothing of the old tree
  // holds it. A port another process took first (EADDRINUSE, as on a busy CI runner) is left to it, and the same check
  // holds of whoever holds it; any other error taking it fails.
  const squat = createServer();
  const took = await new Promise((resolve) => {
    squat.once("error", (error) => resolve(error));
    squat.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (took !== true) {
    assert.equal(took?.code, "EADDRINUSE", `taking the freed proxy port ${port} fails only because another process holds it: ${took?.message ?? took}`);
    t.diagnostic(`the freed proxy port ${port} was already taken by another process`);
    assert.deepEqual(await oldListeners(port, oldTree), [], "a listener another process holds on the freed port is not the old proxy");
  } else {
    t.diagnostic(`the freed proxy port ${port} was taken by this test after the kill`);
    try {
      assert.ok(await accepts(port), "the freed port, taken by this test, answers");
      assert.deepEqual(await oldListeners(port, oldTree), [], "a listener another process holds on the freed port is not the old proxy");
    } finally {
      await new Promise((resolve) => squat.close(resolve));
    }
  }

  // The run is taken back and completes on its next process.
  await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  const after = came.slice(1);
  assert.ok(after.length >= 1, `the next process sent its own request: ${JSON.stringify(came)}`);
  assert.deepEqual(after.filter((r) => r.holder === old || r.holder === undefined), [], `no request after the kill came while the killed process ${old} held the run: ${JSON.stringify(came)}`);
  assert.ok(after.every((r) => r.at >= killed), JSON.stringify(came));
  // And still nothing of the old tree.
  assert.deepEqual((await stillRunning()).map((p) => p.pid), [], "nothing of the old process tree came back");
});
