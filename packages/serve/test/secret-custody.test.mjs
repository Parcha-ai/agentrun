// No process of the server's user can read a secret the server holds: started by its launcher with every secret set,
// neither the server nor a run's process has one in its environment or command line, none holds the launcher's pipe,
// and no pipe any of them holds has a secret left in it. A run's process still gets its own secrets, over its pipe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readdirSync, readFileSync, readlinkSync, readSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_NAMES } from "../dist/secrets.js";
import { client, follow, scratch } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const CUSTODY = new URL("./fixtures/faux-custody.mjs", import.meta.url).pathname;
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

/** The server, started by its launcher in a session of its own, with `secrets` in its environment. */
async function launched(t, secrets) {
  const data = join(await scratch(t), "agents");
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", "--faux", CUSTODY], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...secrets } });
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
  return { session: child.pid, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], secrets.AGENTRUN_TOKEN) };
}

test("started by its launcher, no process of its user holds a secret in its environment, command line or a pipe, and a run's process gets its own over its pipe", { timeout: 120_000 }, async (t) => {
  for (const name of READ) assert.ok(SECRET_NAMES.includes(name), `${name} is on the launcher's list of secrets`);
  const canary = `not-a-secret-${process.pid}-${Date.now()}`;
  const secrets = Object.fromEntries([...new Set([...READ, ...SECRET_NAMES])].map((name) => [name, `${canary}-${name}`]));
  const { session, api } = await launched(t, secrets);
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
  const all = processes();
  const ours = all.filter((p) => p.session === session);
  assert.ok(ours.length >= 2, `the server and the run's process are found: ${ours.map((p) => p.cmdline.toString().slice(0, 60)).join(" | ")}`);
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
});

test("the launcher run through a link, as a package manager installs a bin, finds the server beside its real path", async (t) => {
  const link = join(await scratch(t), "agentrun-serve");
  symlinkSync(LAUNCHER, link);
  const child = spawn(link, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_MODEL_API_KEY: "not-a-secret-help" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, out);
  assert.match(out, /^usage: agentrun-serve /m);
});
