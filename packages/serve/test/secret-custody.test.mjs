// No process of the server's user can read a secret the server holds: started by its launcher with every secret set,
// neither the server nor a run's process has one in its environment or command line, none holds the launcher's pipe,
// and no pipe any of them holds has a secret left in it. A run's process still gets its own secrets, over its pipe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_NAMES } from "../dist/secrets.js";
import { fakeAnthropic } from "@parcha/agentrun-claude-agent/testing";
import { agent, client, follow, scratch } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const CUSTODY = new URL("./fixtures/faux-custody.mjs", import.meta.url).pathname;
const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CONFINED = existsSync("/usr/bin/setpriv");
const SERVER_ONLY = ["AGENTRUN_TOKEN", "AGENTRUN_API_KEY"];
/** Every secret serve and a run's process read: each must be on the launcher's list. */
const READ = [...SERVER_ONLY, "AGENT_MODEL_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BROWSERBASE_API_KEY"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const read = (path) => {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};

/** Every process of this user but this test's own: its pid, session, and what /proc shows of it. */
function processes() {
  const out = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    if (Number(pid) === process.pid) continue;
    const status = read(`/proc/${pid}/status`)?.toString();
    if (!status || /^Uid:\s+(\d+)/m.exec(status)?.[1] !== String(process.getuid())) continue;
    const stat = read(`/proc/${pid}/stat`)?.toString() ?? "";
    const session = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
    out.push({ pid: Number(pid), session, environ: read(`/proc/${pid}/environ`) ?? Buffer.alloc(0), cmdline: read(`/proc/${pid}/cmdline`) ?? Buffer.alloc(0) });
  }
  return out;
}

/** What each descriptor of `pid` points at, and what any pipe of it has unread (read without blocking). */
function descriptors(pid) {
  const out = [];
  let fds = [];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return out;
  }
  for (const fd of fds) {
    let target;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    let unread = Buffer.alloc(0);
    if (target.startsWith("pipe:") || target.endsWith(" (deleted)")) {
      try {
        const own = openSync(`/proc/${pid}/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
        const chunks = [];
        for (const chunk = Buffer.alloc(65_536); ; ) {
          let got = 0;
          try {
            got = readSync(own, chunk, 0, chunk.length, null);
          } catch {
            break;
          }
          if (got === 0) break;
          chunks.push(Buffer.from(chunk.subarray(0, got)));
        }
        closeSync(own);
        unread = Buffer.concat(chunks);
      } catch {}
    }
    out.push({ fd: Number(fd), target, unread });
  }
  return out;
}

/** A canary for every secret this test expects the launcher to name, checked against its list. */
function canaries() {
  for (const name of READ) assert.ok(SECRET_NAMES.includes(name), `${name} is on the launcher's list of secrets`);
  const canary = `not-a-secret-${process.pid}-${Date.now()}`;
  return { canary, secrets: Object.fromEntries([...new Set([...READ, ...SECRET_NAMES])].map((name) => [name, `${canary}-${name}`])) };
}

/** The server, started by its launcher in a session of its own, with `env` (its secrets among it) in its environment. */
async function launched(t, env, args = ["--faux", CUSTODY]) {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  // The launcher's own temporary directory, where its FIFO is made: the test's, so it can see that nothing is left.
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env, TMPDIR: tmp } });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_BASE_URL=(\S+)/.test(out); i++) {
    assert.ok(i < 300, `the server started: ${out}`);
    await sleep(50);
  }
  assert.deepEqual(readdirSync(tmp), [], "the launcher's FIFO and its directory are gone");
  return { root: child.pid, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], env.AGENTRUN_TOKEN) };
}

/** `root` and every process under it (a harness's CLI may start a session of its own, so not by session). */
function treeOf(root) {
  const out = new Set([root]);
  for (const queue = [root]; queue.length; ) {
    const pid = queue.shift();
    let tasks = [];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {}
    for (const task of tasks) {
      for (const child of (read(`/proc/${pid}/task/${task}/children`)?.toString() ?? "").split(" ").filter(Boolean).map(Number)) {
        if (!out.has(child)) out.add(child), queue.push(child);
      }
    }
  }
  return out;
}

/** No process of this user holds `canary` in its environment or command line; none under `root` (the launcher's, now
 *  the server's) holds the launcher's pipe or a pipe with `canary` unread. Answers those processes' command lines. */
function noSecretAnywhere(root, canary) {
  const all = processes();
  const tree = treeOf(root);
  const ours = all.filter((p) => tree.has(p.pid));
  for (const p of all) {
    assert.ok(!p.environ.includes(canary), `pid ${p.pid}'s environment holds a secret: ${p.cmdline.toString().replaceAll("\0", " ").slice(0, 120)}`);
    assert.ok(!p.cmdline.includes(canary), `pid ${p.pid}'s command line holds a secret`);
  }
  for (const p of ours) {
    for (const { fd, target, unread } of descriptors(p.pid)) {
      assert.ok(!/agentrun-serve\.[^/]+\/secrets/.test(target), `pid ${p.pid} still holds the launcher's pipe on fd ${fd}`);
      assert.ok(!unread.includes(canary), `pid ${p.pid}'s fd ${fd} (${target}) has a secret unread`);
    }
  }
  return ours.map((p) => p.cmdline.toString().replaceAll("\0", " "));
}

test("started by its launcher, no process of its user holds a secret in its environment, command line or a pipe, and a run's process gets its own over its pipe", { timeout: 120_000 }, async (t) => {
  const { canary, secrets } = canaries();
  const { root, api } = await launched(t, { ...secrets, LC_ALL: "C.UTF-8" });
  // The launcher counts bytes in the C locale, for its own shell only: the server gets the caller's locale back.
  assert.ok(read(`/proc/${root}/environ`).toString().split("\0").includes("LC_ALL=C.UTF-8"), "the server keeps the caller's LC_ALL");
  assert.equal((await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [] } })).status, 201);

  // A run's process says what it was handed: each secret but the server's own, none in its environment, its pipe closed.
  const { body: run } = await api("POST", "/agents/custody/runs", { input: { content: "Report." } });
  await follow(api, run.run_id, ["completed"]);
  const report = JSON.parse((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer);
  for (const name of SECRET_NAMES) assert.equal(report.handed[name], SERVER_ONLY.includes(name) ? "none" : digest(secrets[name]), `${name} handed to the run's process`);
  assert.deepEqual(report.inEnv, [], "no secret in the run's process's environment, so none in a child's");
  assert.deepEqual(report.pipe, { fd: 3, closed: true }, "the run's process read its pipe and closed it");

  // A run whose process is up, holding its turn, while every process of this user is read.
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Hold." })).status, 202);
  for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working"; i++) {
    assert.ok(i < 200, "the held turn works");
    await sleep(50);
  }
  await sleep(500);
  const seen = noSecretAnywhere(root, canary);
  assert.ok(seen.length >= 2, `the server and the run's process are found: ${seen.map((c) => c.slice(0, 60)).join(" | ")}`);
  // The run's process reads its pipe in a preload, before pi-durable-disk's CLI loads: nothing runs ahead of it that
  // could start a child holding the pipe.
  const runArgv = seen.find((cmdline) => cmdline.includes(" --app "))?.split(" ") ?? [];
  const preload = runArgv.indexOf("--import");
  assert.ok(preload > 0 && runArgv[preload + 1]?.endsWith("/dist/secrets.js") && runArgv.findIndex((arg) => arg.includes("pi-durable-disk")) > preload + 1, `the run's process preloads secrets.js before its CLI: ${runArgv.join(" ").slice(0, 200)}`);
});

test("the launcher run through a link, as a package manager installs a bin, finds the server beside its real path", async (t) => {
  const link = join(await scratch(t), "agentrun-serve");
  symlinkSync(LAUNCHER, link);
  const child = spawn(link, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_MODEL_API_KEY: `not-a-secret-${"help"}` } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, out);
  assert.match(out, /^usage: agentrun-serve /m);
});

/** A loopback gateway that holds the first Responses request until released: Codex's process lives meanwhile. */
async function heldGateway(t) {
  const seen = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const server = createServer(async (req, res) => {
    // Only the API's own paths count: a host's loopback prober (a keyless GET /) is not a request of the run's.
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    seen.push({ path: req.url, authorization: req.headers.authorization });
    await held;
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" }).end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}

test("on codex, with its turn held inside Codex's own process, no process of the user holds a secret; Codex's model request still carries the gateway's key", { timeout: 120_000, skip: !CONFINED && "no setpriv" }, async (t) => {
  const { canary, secrets } = canaries();
  const gw = await heldGateway(t);
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  copyFileSync(STAND_IN, standIn);
  const { root, api } = await launched(t, {
    ...secrets,
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: gw.origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_PRICE: "1,2,0.5",
  }, []);
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  assert.equal((await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } })).status, 202);
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 400, "Codex's model request reaches the gateway");
    await sleep(100);
  }
  assert.equal(gw.seen[0].authorization, `Bearer ${secrets.AGENT_MODEL_API_KEY}`, "the gateway's key reached the run's process over its pipe, and its proxy put it on the request");
  const seen = noSecretAnywhere(root, canary);
  assert.ok(seen.some((cmdline) => cmdline.includes(standIn)), `Codex's process is among those read: ${seen.map((c) => c.slice(0, 60)).join(" | ")}`);
});

test("on claude-agent, with its turn held inside the Claude CLI, no process of the user holds a secret; the CLI's request still carries a key", { timeout: 120_000, skip: !CONFINED && "no setpriv" }, async (t) => {
  const { canary, secrets } = canaries();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const fake = await fakeAnthropic({ reply: () => ({ hold: held, then: { text: "Claude answered." } }) });
  t.after(() => fake.close());
  const { root, api } = await launched(t, { ...secrets, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, []);
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent" }))).status, 201);
  assert.equal((await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } })).status, 202);
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 600, "the CLI's model request reaches the endpoint");
    await sleep(100);
  }
  assert.equal(fake.messages()[0].authorized, true, "a key reached the CLI's request, through the run's proxy");
  const seen = noSecretAnywhere(root, canary);
  assert.ok(seen.some((cmdline) => /claude-agent-sdk-[a-z0-9-]+\/claude /.test(`${cmdline} `)), `the Claude CLI is among those read: ${seen.map((c) => c.slice(0, 60)).join(" | ")}`);
});

test("secrets past what a pipe is sure to hold are refused before the server starts, saying so, never a hang", async (t) => {
  const tmp = await scratch(t);
  const child = spawn(LAUNCHER, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmp, AGENT_MODEL_API_KEY: `not-a-secret-${"x".repeat(5_000)}` } });
  let out = "";
  child.stderr.on("data", (chunk) => (out += chunk));
  const code = await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000).then(() => "hung")]);
  assert.equal(code, 1, out);
  assert.match(out, /more than the 4096 a pipe is sure to hold/);
});
