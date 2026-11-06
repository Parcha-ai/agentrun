// No process of the server's user can read a secret the server holds: started by its launcher with every secret set,
// neither the server nor a run's process has one in its environment or command line, none holds the launcher's pipe,
// and no pipe any of them holds has a secret left in it. A run's process still gets its own secrets, over its pipe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_NAMES } from "../dist/secrets.js";
import { PROVIDER_KEYS } from "../dist/model.js";
import { keyShaped } from "../dist/secret-cut.js";
import { BOX_KEYS } from "../dist/boxes.js";
import { ToolKeys } from "../dist/tool-keys.js";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, answerFlow, client, FAUX, flowAgent, follow, printed, responsesEndpoint, scratch } from "./support.mjs";
import { CANARY as JEV_CANARY } from "./fixtures/faux-jev.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { reported } from "./fixtures/custody-report.mjs";
// A run's served answer has no held secret in it, so what a custody run's process reported is read as it wrote it
// (fixtures/custody-report.mjs), never from the answer.
process.env.CUSTODY_REPORT_DIR ??= mkdtempSync(join(tmpdir(), "custody-reports-"));

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const CUSTODY = new URL("./fixtures/faux-custody.mjs", import.meta.url).pathname;
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CONFINED = existsSync("/usr/bin/setpriv");
/** The server's own: its token, the seal key its tool keys are kept under, and the boxes' keys, which only its box
 *  providers read (boxes.ts). */
const SERVER_ONLY = ["AGENTRUN_TOKEN", "AGENTRUN_API_KEY", "AGENTRUN_SEAL_KEY", ...BOX_KEYS];
/** Every secret serve and a run's process read: each must be on the launcher's list. */
/** The decision keys: held by the server like the rest, and handed to a workflow run's process only on its decision
 *  descriptor, for its decision provider (decisions.ts), never with the run's secrets. */
const DECISION_KEYS = ["TYPESAFE_API_KEY", "PARALLEL_API_KEY"];
/** The tool keys on the pipe: a run's process gets one only when its revision names a tool the key unlocks (the monid
 *  tools, `browser`). Browserbase's project id is a field of its key, and goes with it; Kernel's key unlocks `browser`
 *  too, the run's plane picking the vendor. */
const BROWSERBASE = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"];
const BROWSER = [...BROWSERBASE, "KERNEL_API_KEY"];
const TOOL_KEYS = ["MONID_API_KEY", ...BROWSER];
/** The model keys: every key of pi-ai's providers and the gateway's. A run's process gets those its model needs and no
 *  other: a pi run its model's provider's (per tier), or the gateway's behind AGENT_MODEL_BASE_URL; codex OpenAI's, or
 *  the gateway's; claude-agent Anthropic's. TypeSafe's is a decision key, never on the pipe. */
const MODEL_KEYS = [...new Set([...Object.values(PROVIDER_KEYS).flat(), "AGENT_MODEL_API_KEY"])].filter((name) => !DECISION_KEYS.includes(name));
/** The names a run's process was handed (faux-custody.mjs' report), sorted. */
const heldBy = (handed) => Object.entries(handed).filter(([, value]) => value !== "none").map(([name]) => name).sort();
/** Amazon Bedrock's keys, which pi-ai's table of keys by provider leaves out as ambient: its request reads them itself. */
const BEDROCK = ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
/** The keys pi-ai reads for each of its built-in providers, by its own table (findEnvKeys, asked of an environment that
 *  sets every name), and the names each provider's auth asks its context for when none is set. */
async function piAiKeys() {
  const { findEnvKeys } = await import("@earendil-works/pi-ai/compat");
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const every = new Proxy({}, { get: () => "set" });
  const out = {};
  for (const { id } of builtinModels().getProviders()) {
    const asked = new Set();
    await builtinModels({ authContext: { env: async (name) => void asked.add(name), fileExists: async () => false } }).getAuth(id);
    out[id] = { table: findEnvKeys(id, every) ?? [], asked: [...asked] };
  }
  return out;
}
const READ = [...SERVER_ONLY, "AGENT_MODEL_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BROWSERBASE_API_KEY", "OPENROUTER_API_KEY", "MONID_API_KEY", ...DECISION_KEYS];
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
  // Short, each its own: every secret set at once goes over the launcher's pipe, which holds 4096 bytes for sure, and
  // the list grows with pi-ai's providers. The token's is the API's, 32 characters or more.
  const canary = `nak-${process.pid}-${Date.now().toString(36)}`;
  return { canary, secrets: Object.fromEntries([...new Set([...READ, ...SECRET_NAMES])].map((name, i) => [name, name === "AGENTRUN_TOKEN" ? `${canary}-${name}` : `${canary}-${i}`])) };
}

/** The server, started by its launcher in a session of its own, with `env` (its secrets among it) in its environment.
 *  `args` are the server's, or, as a function of its data directory, the launcher's own (`-- COMMAND ...`). */
async function launched(t, env, args = ["--faux", CUSTODY]) {
  // Its own directory, gone only once every process under the launcher is (below): a harness's CLI starts a session
  // of its own, which a kill of the launcher's group does not reach, and it may still be writing there.
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  const data = join(dir, "agents");
  // The launcher's own temporary directory, where its FIFO is made: the test's, so it can see that nothing is left.
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  // The seal key the launcher makes when none is given goes in the test's own config directory, never the user's.
  const child = spawn(LAUNCHER, typeof args === "function" ? args(data) : ["--data", data, "--port", "0", ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), ...env, TMPDIR: tmp } });
  // Whether the launcher's pid is still its own: once it exits and Node reaps it, that number, and so its group's id, can
  // be given to another process (on this box the PIDs wrap in minutes under test load, so another lane's), and a kill of
  // it or of the group, or a walk from it, would reach that process. Each is done only while it is alive.
  let alive = true;
  child.once("exit", () => {
    alive = false;
  });
  t.after(async () => {
    // Every process under the launcher, found before it goes (its children then belong to init), killed, and waited for.
    // Read and signalled in one turn of the event loop, so the launcher is not reaped between the check and the kill.
    const tree = new Set(alive ? treeOf(child.pid) : []);
    for (let round = 0; round < 2; round++) {
      for (const pid of [...tree]) for (const under of treeOf(pid)) tree.add(under);
      if (alive) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      for (const pid of tree) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    // The launcher is waited for by its exit (alive), never by its number, which another process may hold once reaped.
    for (const end = Date.now() + 10_000; [...tree].some((pid) => (pid === child.pid ? alive : processAlive(pid))); await sleep(50)) {
      if (Date.now() > end) throw new Error(`still running after the test: ${[...tree].filter((pid) => processAlive(pid)).map((pid) => `${pid} ${read(`/proc/${pid}/cmdline`)?.toString().replaceAll("\0", " ").slice(0, 80)}`).join("; ")}`);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const out = await printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  assert.deepEqual(readdirSync(tmp), [], "the launcher's FIFO and its directory are gone");
  return { root: child.pid, child, data, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], env.AGENTRUN_TOKEN), output: () => out };
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

/** No process of this user holds a canary in its environment or command line; none under `root` (the launcher's, now
 *  the server's) holds the launcher's pipe or a pipe with a canary unread. Answers those processes' command lines. */
function noSecretAnywhere(root, ...canaries) {
  const all = processes();
  const tree = treeOf(root);
  const ours = all.filter((p) => tree.has(p.pid));
  for (const p of all) {
    for (const canary of canaries) {
      assert.ok(!p.environ.includes(canary), `pid ${p.pid}'s environment holds a secret: ${p.cmdline.toString().replaceAll("\0", " ").slice(0, 120)}`);
      assert.ok(!p.cmdline.includes(canary), `pid ${p.pid}'s command line holds a secret`);
    }
  }
  for (const p of ours) {
    for (const { fd, target, unread } of descriptors(p.pid)) {
      assert.ok(!/agentrun-serve\.[^/]+\/secrets/.test(target), `pid ${p.pid} still holds the launcher's pipe on fd ${fd}`);
      for (const canary of canaries) assert.ok(!unread.includes(canary), `pid ${p.pid}'s fd ${fd} (${target}) has a secret unread`);
    }
  }
  return ours.map((p) => p.cmdline.toString().replaceAll("\0", " "));
}

test("started by its launcher, no process of its user holds a secret in its environment, command line or a pipe, and a run's process gets its own over its pipe", { timeout: 120_000 }, async (t) => {
  const { canary, secrets } = canaries();
  const { root, api } = await launched(t, { ...secrets, LC_ALL: "C.UTF-8" });
  // The launcher counts bytes in the C locale, for its own shell only: the server gets the caller's locale back.
  assert.ok(read(`/proc/${root}/environ`).toString().split("\0").includes("LC_ALL=C.UTF-8"), "the server keeps the caller's LC_ALL");
  assert.equal((await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-4o" } })).status, 201);

  // A run's process says what it was handed: of every secret set, its model's key alone (OpenAI's), none in its
  // environment, its pipe closed.
  const { body: run } = await api("POST", "/agents/custody/runs", { input: { content: "Report." } });
  await follow(api, run.run_id, ["completed"]);
  const report = reported(run.run_id);
  for (const name of SECRET_NAMES) assert.equal(report.handed[name], name === "OPENAI_API_KEY" ? digest(secrets[name]) : "none", `${name} handed to the run's process`);
  assert.deepEqual(heldBy(report.handed), ["OPENAI_API_KEY"], "exactly its model's key");
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

/** The launcher's arguments for a server whose data directory holds `saved` (by key id, its fields) as tool keys already,
 *  sealed under `key`: written as the server writes them, before it starts. */
const savedBefore = (key, saved) => (data) => {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const keys = new ToolKeys(data, { AGENTRUN_SEAL_KEY: key }, () => undefined);
  for (const [id, values] of Object.entries(saved)) keys.save(id, { values });
  return ["--data", data, "--port", "0", "--faux", CUSTODY];
};

test("under its launcher, a tool key saved through the settings API reaches the next run's process over its pipe, never an environment; the launcher's value wins for a name it holds; the seal key reaches no run", { timeout: 120_000 }, async (t) => {
  const canary = `not-a-secret-saved-${process.pid}-${Date.now()}`;
  const seal = randomBytes(32).toString("base64");
  const value = (name, where) => `${canary}-${where}-${name}`;
  // BROWSERBASE_API_KEY saved before the start and held by the launcher too: the launcher's is the one a run gets.
  const { root, api } = await launched(t, { AGENTRUN_TOKEN: value("AGENTRUN_TOKEN", "launcher"), AGENTRUN_SEAL_KEY: seal, BROWSERBASE_API_KEY: value("BROWSERBASE_API_KEY", "launcher") }, savedBefore(seal, { browserbase: { BROWSERBASE_API_KEY: value("BROWSERBASE_API_KEY", "saved") } }));
  // Its tools name what each key unlocks: a run gets a tool key only then.
  assert.equal((await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: ["monid.run", "browser"] } })).status, 201);
  const saved = { MONID_API_KEY: value("MONID_API_KEY", "saved"), BROWSERBASE_PROJECT_ID: value("BROWSERBASE_PROJECT_ID", "saved") };
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved.MONID_API_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_PROJECT_ID: saved.BROWSERBASE_PROJECT_ID } })).status, 204);
  const fields = Object.fromEntries((await api("GET", "/settings/tool-keys")).body.keys.flatMap((key) => key.fields.map((field) => [field.name, field.source])));
  assert.deepEqual(fields, { PARALLEL_API_KEY: null, MONID_API_KEY: "stored", BROWSERBASE_API_KEY: "server", BROWSERBASE_PROJECT_ID: "stored", KERNEL_API_KEY: null, TYPESAFE_API_KEY: null, ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, OPENROUTER_API_KEY: null }, "the launcher's is the server's; the saved ones are stored, never the server's");
  const handed = async () => {
    const { body: run } = await api("POST", "/agents/custody/runs", { input: { content: "Report." } });
    await follow(api, run.run_id, ["completed"]);
    return { id: run.run_id, ...reported(run.run_id) };
  };
  const report = await handed();
  assert.deepEqual(Object.fromEntries(["MONID_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_TOKEN"].map((name) => [name, report.handed[name]])), {
    MONID_API_KEY: digest(saved.MONID_API_KEY),
    BROWSERBASE_PROJECT_ID: digest(saved.BROWSERBASE_PROJECT_ID),
    BROWSERBASE_API_KEY: digest(value("BROWSERBASE_API_KEY", "launcher")),
    AGENTRUN_SEAL_KEY: "none",
    AGENTRUN_TOKEN: "none",
  }, "saved after the start and handed at the run's launch; the launcher's wins; the server's own never");
  assert.deepEqual(report.inEnv, [], "none in the run's process's environment");
  assert.deepEqual(report.pipe, { fd: 3, closed: true });
  // Deleted, the next run that names monid is refused for it, launching no process.
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  const refused = await api("POST", "/agents/custody/runs", { input: { content: "Report." } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.missing], [409, "agent_not_runnable", { "monid.run": ["MONID_API_KEY"] }]);

  // The first run's process up again, holding its turn, while every process of this user is read once (a pipe's unread
  // bytes are taken as they are read): no saved value, and no seal key.
  assert.equal((await api("POST", `/runs/${report.id}/messages`, { content: "Hold." })).status, 202);
  for (let i = 0; (await api("GET", `/runs/${report.id}`)).body.state !== "working"; i++) {
    assert.ok(i < 200, "the held turn works");
    await sleep(50);
  }
  await sleep(500);
  const seen = noSecretAnywhere(root, canary, seal, Buffer.from(seal, "base64").toString("hex"));
  assert.ok(seen.some((cmdline) => cmdline.includes(" --app ")), "the run's process is among those read");
});

test("under its launcher, a Parallel key saved through the settings API reaches a workflow run's decision descriptor: refused before it, answered on it after, with no restart and in no process's environment", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "parallel-calls.jsonl");
  const token = `not-a-secret-token-${process.pid}-${"t".repeat(24)}`;
  const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const { secret } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const server = await startServe({ data: process.argv[1], port: 0, token: secret("AGENTRUN_TOKEN"), faux: ${JSON.stringify(FAUX)}, fauxParallel: ${JSON.stringify(FAUX_PARALLEL)}, drainTimeout: "5s" });
process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");`;
  // No Parallel key anywhere the launcher could take one from: the saved one is the only one.
  const held = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  t.after(() => held !== undefined && (process.env.PARALLEL_API_KEY = held));
  const { root, api } = await launched(t, { AGENTRUN_TOKEN: token, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, (data) => ["--", process.execPath, "--input-type=module", "-e", script, data]);
  const coi = {
    v: 2, name: "coi-check",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is \`doc\` a certificate of incorporation?" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Coi", path: "coi" },
    root: { node: "chain", steps: [{ node: "judge", label: "coi-parallel", state: { doc: "{question}" }, out: "Coi", as: "coi", provider: "parallel" }] },
  };
  const parallel = async () => (await api("GET", "/capabilities")).body.workflows.decisions.providers.find((p) => p.id === "parallel").available;
  const start = () => api("POST", "/agents/coi/runs", { input: { question: "State of Delaware. Certificate of Incorporation of Example Widgets, Inc." } });
  assert.equal((await api("POST", "/agents", flowAgent("coi", coi))).status, 201);
  assert.equal(await parallel(), false);
  const refused = await start();
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.decisions], [409, "agent_not_runnable", { parallel: { reason: "not_set_up_here", needs: ["PARALLEL_API_KEY"] } }]);

  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: PARALLEL_CANARY } })).status, 204);
  assert.equal(await parallel(), true, "no restart");
  const { body: started } = await start();
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${started.run_id}`)).body.error));
  const sent = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => [call.path, call.authorized]), [["/v1/monitors", true], ["/v1/decisions", true]], "checked as it was saved (a list of monitors, which costs nothing), then Parallel answered the run on the saved key, handed on the decision descriptor");
  for (const p of processes().filter((p) => treeOf(root).has(p.pid))) {
    assert.ok(!p.environ.includes(PARALLEL_CANARY), `pid ${p.pid}'s environment holds the key`);
    assert.ok(!p.cmdline.includes(PARALLEL_CANARY), `pid ${p.pid}'s command line holds the key`);
  }
});

test("under its launcher, a run's process holds a tool key only when its revision names a tool the key unlocks, and its model's key alone, and the same again after a restart", { timeout: 120_000 }, async (t) => {
  const { secrets } = canaries();
  // The server as the launcher's COMMAND, with the tests' fake browser; SIGUSR2 closes it and starts it again on the
  // same data, so the new server reads each run, and its revision, from the store.
  const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const { secret } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const options = { data: process.argv[1], port: 0, token: secret("AGENTRUN_TOKEN"), faux: ${JSON.stringify(CUSTODY)}, fauxBrowser: ${JSON.stringify(FAUX_BROWSER)}, drainTimeout: "5s" };
let server = await startServe(options);
process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");
process.on("SIGUSR2", async () => {
  await server.close();
  server = await startServe(options);
  process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");
});`;
  const { root, child, api } = await launched(t, secrets, (data) => ["--", process.execPath, "--input-type=module", "-e", script, data]);
  // Each agent's tools, and the tool keys its runs get.
  const agents = { monid: [["monid.run"], ["MONID_API_KEY"]], browse: [["browser"], BROWSER], reader: [["read"], []] };
  // Each on an OpenAI model: OpenAI's key is the one model key each holds.
  const expected = (unlocked) => Object.fromEntries(SECRET_NAMES.map((name) => [name, [...unlocked, "OPENAI_API_KEY"].includes(name) ? digest(secrets[name]) : "none"]));
  const report = async (call, runId, after) => {
    await follow(call, runId, ["completed"], { after, deadlineMs: 60_000 });
    return reported(runId).handed;
  };
  const runs = {};
  for (const [id, [tools, unlocked]] of Object.entries(agents)) {
    assert.equal((await api("POST", "/agents", agent(id, { tools, model: "openai/gpt-4o" }))).status, 201);
    const { status, body } = await api("POST", `/agents/${id}/runs`, { input: { content: "Report." } });
    assert.equal(status, 202, JSON.stringify(body));
    runs[id] = { runId: body.run_id, handed: await report(api, body.run_id) };
    assert.deepEqual(runs[id].handed, expected(unlocked), `a run of ${id} (${tools.join(", ")}) holds ${unlocked.join(", ") || "no tool key"}, and OpenAI's key, no other model key`);
  }

  // A restart: the new server reads each run from the store, and a follow-up opens it again in a new process, which
  // gets what its first did.
  // Its ready line again, or its exit: never a clock (support.mjs printed). Listened for before the signal.
  const restarted = printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  process.kill(root, "SIGUSR2");
  const again = client(/AGENTRUN_BASE_URL=(\S+)/.exec(await restarted)[1], secrets.AGENTRUN_TOKEN);
  for (const [id, { runId, handed }] of Object.entries(runs)) {
    const sent = await again("POST", `/runs/${runId}/messages`, { content: "Report." });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.deepEqual(await report(again, runId), handed, `the run of ${id}, opened again after the restart, holds the same secrets`);
  }
});

/** Model settings a host may hold: none of the test's own reaches a server started by launchedWith. */
const MODEL_SETTINGS = ["AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_PRICE", "ANTHROPIC_BASE_URL", "AGENT_THINKING"];
const CUSTODY_HARNESS = new URL("./fixtures/faux-custody-harness.mjs", import.meta.url).pathname;
/** The server under its launcher, on the faux model for pi and the faux custody harness for claude-agent and codex (each
 *  run answers what its process was handed), with `env` as its only secrets and model settings. */
function launchedWith(t, env) {
  const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const { secret } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const server = await startServe({ data: process.argv[1], port: 0, token: secret("AGENTRUN_TOKEN"), faux: ${JSON.stringify(CUSTODY)}, fauxHarness: ${JSON.stringify(CUSTODY_HARNESS)} });
process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");`;
  const only = { ...Object.fromEntries([...SECRET_NAMES, ...MODEL_SETTINGS].map((name) => [name, undefined])), AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), ...env };
  return launched(t, only, (data) => ["--", process.execPath, "--input-type=module", "-e", script, data]);
}

test("under its launcher, a pi run on the host's default model, which a model key gives, is handed that key: one set where AgentRun starts, or one saved in Settings → Model keys, though neither is ever in the server's environment", { timeout: 120_000 }, async (t) => {
  const canary = `not-a-secret-default-${process.pid}-${Date.now()}`;
  const token = `${canary}-AGENTRUN_TOKEN`;
  // Set where AgentRun starts: the launcher takes it out of the environment, so only the server's secrets hold it.
  const started = await launchedWith(t, { AGENTRUN_TOKEN: token, OPENROUTER_API_KEY: `${canary}-started` });
  assert.equal((await started.api("POST", "/agents", agent("on-default"))).status, 201);
  const fromStart = await custodyReport(started.api, "on-default");
  assert.deepEqual(heldBy(fromStart.handed), ["OPENROUTER_API_KEY"], "the key its default model (OpenRouter's) needs, and no other");
  assert.equal(fromStart.handed.OPENROUTER_API_KEY, digest(`${canary}-started`), "over its pipe, whole");
  // Saved in Settings → Model keys, never in any environment.
  const saved = await launchedWith(t, { AGENTRUN_TOKEN: token });
  assert.equal((await saved.api("PUT", "/settings/tool-keys/openrouter", { values: { OPENROUTER_API_KEY: `${canary}-saved` } })).status, 204);
  assert.equal((await saved.api("POST", "/agents", agent("on-default"))).status, 201);
  const fromSaved = await custodyReport(saved.api, "on-default");
  assert.deepEqual(heldBy(fromSaved.handed), ["OPENROUTER_API_KEY"], "the saved key its default model needs, and no other");
  assert.equal(fromSaved.handed.OPENROUTER_API_KEY, digest(`${canary}-saved`), "the saved value, over its pipe");
});

test("under its launcher, a claude-agent or codex run on OpenRouter's route is handed OPENROUTER_API_KEY, the key its requests carry, and no other: on that key alone, and for a model named on OpenRouter beside Anthropic's key", { timeout: 120_000 }, async (t) => {
  const canary = `not-a-secret-route-${process.pid}-${Date.now()}`;
  const token = `${canary}-AGENTRUN_TOKEN`;
  const alone = await launchedWith(t, { AGENTRUN_TOKEN: token, OPENROUTER_API_KEY: `${canary}-openrouter` });
  for (const harness of ["claude-agent", "codex"]) {
    assert.equal((await alone.api("POST", "/agents", agent(`on-${harness}`, { harness }))).status, 201);
    const report = await custodyReport(alone.api, `on-${harness}`);
    assert.deepEqual(heldBy(report.handed), ["OPENROUTER_API_KEY"], `${harness} on OpenRouter's key alone is handed it, and no other`);
    assert.equal(report.handed.OPENROUTER_API_KEY, digest(`${canary}-openrouter`), "over its pipe, whole");
  }
  const both = await launchedWith(t, { AGENTRUN_TOKEN: token, OPENROUTER_API_KEY: `${canary}-openrouter`, ANTHROPIC_API_KEY: `${canary}-anthropic` });
  assert.equal((await both.api("POST", "/agents", agent("named", { harness: "claude-agent", model: "openrouter/anthropic/claude-sonnet-5.5" }))).status, 201);
  const named = await custodyReport(both.api, "named");
  assert.deepEqual(heldBy(named.handed), ["OPENROUTER_API_KEY"], "a model named on OpenRouter goes there on OpenRouter's key; Anthropic's stays with the server");
});

test("under its launcher behind a gateway, with OpenAI's key saved in Settings and no AGENT_MODEL, a pi run that names no model runs on the key's default through the gateway, on the gateway's key alone: OpenAI's reaches no request", { timeout: 120_000 }, async (t) => {
  const canary = `not-a-secret-gateway-${process.pid}-${Date.now()}`;
  const endpoint = await responsesEndpoint(t, "42", 10);
  const env = { ...Object.fromEntries([...SECRET_NAMES, ...MODEL_SETTINGS].map((name) => [name, undefined])), AGENTRUN_TOKEN: `${canary}-AGENTRUN_TOKEN`, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL_API_KEY: `${canary}-gateway` };
  // No faux: the run's process chooses its own model, as a real run does.
  const { api } = await launched(t, env, []);
  // OpenAI's key: a save does not check it with its provider (key-check.ts' NOT_CHECKED), so this reaches no network.
  assert.equal((await api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: `${canary}-openai` } })).status, 204);
  assert.equal((await api("POST", "/agents", agent("on-default"))).status, 201);
  const { body: started } = await api("POST", "/agents/on-default/runs", { input: { content: "What is six times seven?" } });
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${started.run_id}`)).body.error));
  assert.ok(endpoint.models.length > 0 && endpoint.models.every((model) => model === "openai/gpt-6.1-sol"), `the gateway is asked for the key's default: ${endpoint.models}`);
  assert.ok(endpoint.authorizations.every((sent) => sent === `Bearer ${canary}-gateway`), "on the gateway's key");
  assert.ok(!JSON.stringify(endpoint.bodies).includes(`${canary}-openai`), "OpenAI's key is in no request");
});

test("under its launcher, a key saved with no restart reaches the next run of a revision that already ran without it", { timeout: 120_000 }, async (t) => {
  const canary = `not-a-secret-later-${process.pid}-${Date.now()}`;
  const { api } = await launchedWith(t, { AGENTRUN_TOKEN: `${canary}-AGENTRUN_TOKEN` });
  assert.equal((await api("POST", "/agents", agent("on-default"))).status, 201);
  const before = await custodyReport(api, "on-default");
  assert.deepEqual(heldBy(before.handed), [], "no model key to hand yet");
  assert.equal((await api("PUT", "/settings/tool-keys/openrouter", { values: { OPENROUTER_API_KEY: `${canary}-saved` } })).status, 204);
  const after = await custodyReport(api, "on-default");
  assert.deepEqual(heldBy(after.handed), ["OPENROUTER_API_KEY"], "the same revision's next run holds the key saved since its last");
  assert.equal(after.handed.OPENROUTER_API_KEY, digest(`${canary}-saved`));
});

test("secretsFor: a tool key's fields only for a revision naming a tool its row unlocks, the tools read as the run's process binds them; every other secret for each", async () => {
  const { RUN_SECRETS, secretsFor } = await import("../dist/runs.js");
  // On no host model: a revision naming no model takes no provider's key (the next test).
  const secretsOf = (rev, rows) => secretsFor(rev, rows, {});
  const revision = (kind, body) => ({ id: "r".repeat(64), agent: "a", parent: null, createdAt: "2026-11-01T00:00:00.000Z", kind, body: { skills: {}, tools: [], ...body } });
  const agentic = (tools) => revision("agentic", { instructions: "Answer.", tools });
  const workflow = (flow, tools = []) => revision("workflow", { workflow: flow, tools });
  const without = (...names) => RUN_SECRETS.filter((name) => !names.includes(name) && !MODEL_KEYS.includes(name));
  for (const name of [...TOOL_KEYS, ...MODEL_KEYS]) assert.ok(RUN_SECRETS.includes(name), `${name} is among a run's secrets`);

  assert.deepEqual(await secretsOf(agentic(["monid.run"])), without(...BROWSER));
  assert.deepEqual(await secretsOf(agentic(["read", "browser"])), without("MONID_API_KEY"));
  assert.deepEqual(await secretsOf(agentic(["monid.discover", "browser"])), without());
  assert.deepEqual(await secretsOf(agentic(["read", "fetch_page", "ask_person"])), without(...TOOL_KEYS));
  assert.deepEqual(await secretsOf(agentic([])), without(...TOOL_KEYS));
  // Only a `tool` row's fields are scoped by the tools: a row of another kind (a model's) leaves its field to the model,
  // so a run on OpenAI's model gets OpenAI's key, unless the same row is a tool key's that unlocks none of its tools.
  const { TOOL_KEYS: ROWS } = await import("../dist/tool-keys.js");
  assert.deepEqual(ROWS.map((row) => [row.id, row.kind]), [["parallel", "tool"], ["monid", "tool"], ["browserbase", "tool"], ["kernel", "tool"], ["typesafe", "tool"], ["anthropic", "model"], ["openai", "model"], ["openrouter", "model"]]);
  const onOpenai = revision("agentic", { instructions: "Answer.", tools: [], model: "openai/gpt-4o" });
  assert.deepEqual(await secretsOf(onOpenai, ROWS), [...without(...TOOL_KEYS), "OPENAI_API_KEY"].sort((a, b) => RUN_SECRETS.indexOf(a) - RUN_SECRETS.indexOf(b)), "OPENAI_API_KEY with them, the tool keys still not");
  assert.deepEqual(await secretsOf(onOpenai, ROWS.map((row) => (row.id === "openai" ? { ...row, kind: "tool" } : row))), without(...TOOL_KEYS), "the same row as a tool key is scoped");

  // A workflow: the tools its model nodes name and its call nodes run, wherever the node is, never a name only its
  // definition lists, nor data shaped like a node.
  const browsing = answerFlow();
  browsing.root.steps[0].tools = ["browser"];
  assert.deepEqual(await secretsOf(workflow(browsing, ["browser", "monid.run"])), without("MONID_API_KEY"));
  const calling = answerFlow();
  calling.root.steps.unshift({ node: "map", label: "each", itemsPath: "question", as: "found", resultPath: "found", maxConcurrency: 1, body: { node: "call", label: "find", via: "tool", tool: "monid.run", args: { q: "{item}" }, out: "Answer", as: "answer", deadline_s: 20 } });
  assert.deepEqual(await secretsOf(workflow(calling)), without(...BROWSER));
  const shaped = answerFlow();
  shaped.root.steps[0].state = { example: { node: "extract", tools: ["browser"] } };
  assert.deepEqual(await secretsOf(workflow(shaped, ["browser"])), without(...TOOL_KEYS));
});

test("secretsFor: a run is handed exactly the model keys its model needs: a pi run its model's provider's, per tier, or the gateway's behind AGENT_MODEL_BASE_URL; codex OpenAI's or the gateway's; claude-agent Anthropic's; and of the rest, what it would be with no model", async () => {
  const { RUN_SECRETS, secretsFor } = await import("../dist/runs.js");
  const revision = (kind, body) => ({ id: "r".repeat(64), agent: "a", parent: null, createdAt: "2026-11-03T00:00:00.000Z", kind, body: { skills: {}, tools: [], ...body } });
  const agentic = (extra = {}) => revision("agentic", { instructions: "Answer.", ...extra });
  const others = RUN_SECRETS.filter((name) => !MODEL_KEYS.includes(name) && !TOOL_KEYS.includes(name));
  /** The model keys a run of `rev` is handed on a host of `env`, sorted; and the rest exactly what a run naming no
   *  model and no tool gets. */
  const held = async (rev, env) => {
    const names = await secretsFor(rev, undefined, env);
    assert.deepEqual(names.filter((name) => !MODEL_KEYS.includes(name)), others, "no model key, and nothing but the model keys changes");
    return names.filter((name) => MODEL_KEYS.includes(name)).sort();
  };
  const GATEWAY = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:1" };
  const ANTHROPIC = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"];
  assert.deepEqual(await held(agentic({ model: "google/gemini-2.5-flash" }), {}), ["GEMINI_API_KEY"], "its own model's provider's");
  assert.deepEqual(await held(agentic({ model: "openrouter/anthropic/claude-sonnet-4.5" }), {}), ["OPENROUTER_API_KEY"], "OpenRouter's alone for a model through OpenRouter");
  assert.deepEqual(await held(agentic({ model: "openai/gpt-4o" }), {}), ["OPENAI_API_KEY"]);
  assert.deepEqual(await held(agentic({ model: "anthropic/claude-haiku-4-5" }), {}), ANTHROPIC, "each key Anthropic's provider reads");
  assert.deepEqual(await held(agentic(), { AGENT_MODEL: "deepseek/deepseek-chat" }), ["DEEPSEEK_API_KEY"], "the host's default model's");
  assert.deepEqual(await held(agentic({ model: "google/gemini-2.5-flash" }), { AGENT_MODEL: "deepseek/deepseek-chat" }), ["GEMINI_API_KEY"], "its own wins over the host's");
  assert.deepEqual(await held(agentic({ model: "amazon-bedrock/amazon.nova-lite-v1:0" }), {}), [...BEDROCK].sort(), "Bedrock's AWS keys, together");
  assert.deepEqual(await held(agentic(), {}), [], "no model, no model key");
  assert.deepEqual(await held(agentic({ model: "google/gemini-2.5-flash" }), GATEWAY), ["AGENT_MODEL_API_KEY"], "through a gateway every model is the gateway's, on its key");
  assert.deepEqual(await held(agentic({ harness: "codex", model: "openai/gpt-4o" }), {}), ["OPENAI_API_KEY"], "codex: OpenAI's");
  assert.deepEqual(await held(agentic({ harness: "codex" }), { ...GATEWAY, AGENT_MODEL: "gpt-test" }), ["AGENT_MODEL_API_KEY"], "codex behind a gateway: the gateway's");
  assert.deepEqual(await held(agentic({ harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }), {}), ["ANTHROPIC_API_KEY"], "claude-agent: Anthropic's");
  assert.deepEqual(await held(agentic({ harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }), { ...GATEWAY, ANTHROPIC_BASE_URL: "http://127.0.0.1:2" }), ["ANTHROPIC_API_KEY"], "claude-agent's model is its own, never the gateway's");
  // OpenRouter's route (#1537): the key a harness's requests carry there.
  const OPENROUTER = { OPENROUTER_API_KEY: "set" };
  assert.deepEqual(await held(agentic({ harness: "claude-agent" }), OPENROUTER), ["OPENROUTER_API_KEY"], "claude-agent on OpenRouter's key alone: OpenRouter's");
  assert.deepEqual(await held(agentic({ harness: "codex" }), OPENROUTER), ["OPENROUTER_API_KEY"], "codex on OpenRouter's key alone: OpenRouter's");
  assert.deepEqual(await held(agentic({ harness: "claude-agent", model: "openrouter/anthropic/claude-sonnet-5.5" }), { ...OPENROUTER, ANTHROPIC_API_KEY: "set" }), ["OPENROUTER_API_KEY"], "a model named on OpenRouter, beside Anthropic's key: OpenRouter's");
  assert.deepEqual(await held(agentic({ harness: "codex", model: "openrouter/openai/gpt-6-sol" }), { ...OPENROUTER, OPENAI_API_KEY: "set" }), ["OPENROUTER_API_KEY"], "codex on a model named on OpenRouter, beside OpenAI's key: OpenRouter's");
  assert.deepEqual(await held(agentic(), OPENROUTER), ["OPENROUTER_API_KEY"], "a pi run on the default OpenRouter's key gives");
  // A workflow: the host's model of each tier its model nodes and `llm` calls use.
  const flow = answerFlow();
  flow.root.steps[0].tier = "fast";
  const workflow = revision("workflow", { workflow: flow });
  assert.deepEqual(await held(workflow, { AGENT_MODEL: "deepseek/deepseek-chat", AGENT_MODEL_FAST: "google/gemini-2.5-flash" }), ["GEMINI_API_KEY"], "its fast tier's, not the default it does not run");
  flow.root.steps.unshift({ node: "call", label: "draft", via: "tool", tool: "llm", args: { prompt: "{question}" }, out: "Answer", as: "draft", deadline_s: 120 });
  const drafting = revision("workflow", { workflow: flow });
  assert.deepEqual(await held(drafting, { AGENT_MODEL: "deepseek/deepseek-chat", AGENT_MODEL_FAST: "google/gemini-2.5-flash" }), ["DEEPSEEK_API_KEY", "GEMINI_API_KEY"], "and the default tier an llm call runs on");
  assert.deepEqual(await held(drafting, { ...GATEWAY, AGENT_MODEL: "m-1" }), ["AGENT_MODEL_API_KEY"], "a workflow behind a gateway: the gateway's");
});

/** The names a provider's auth asks for that no run is handed, each with why. Every other name pi-ai reads for a provider
 *  is a held key. */
const NOT_HANDED = {
  // Settings, no secret: they pass into a run's environment.
  AWS_PROFILE: "a profile's name; its credentials are the host's ~/.aws files",
  GOOGLE_CLOUD_PROJECT: "Vertex's project", GCLOUD_PROJECT: "Vertex's project", GOOGLE_CLOUD_LOCATION: "Vertex's region",
  CLOUDFLARE_ACCOUNT_ID: "an account's id", CLOUDFLARE_GATEWAY_ID: "a gateway's id",
  ANTHROPIC_FEDERATION_RULE_ID: "a federation rule's id",
  // Pointers to a credential, named like a key: cut from every run's environment, where the SDK alone reads them, so not
  // supported for runs (the README's Safety).
  AWS_WEB_IDENTITY_TOKEN_FILE: "a web identity token's file, which the AWS SDK finds in the environment alone",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "a container role's credentials, which the AWS SDK finds in the environment alone",
  AWS_CONTAINER_CREDENTIALS_FULL_URI: "a container role's credentials, which the AWS SDK finds in the environment alone",
  GOOGLE_APPLICATION_CREDENTIALS: "a service account's file, which Google's SDK finds in the environment alone",
};

test("every name pi-ai's providers read is a held key handed by provider, or named here as no run's with its reason: pi-ai's own table, each name a provider's auth asks for, and Bedrock's AWS keys, which that table leaves out", async () => {
  const keys = await piAiKeys();
  assert.ok(["google", "deepseek", "amazon-bedrock"].every((id) => id in keys), Object.keys(keys).join(" "));
  /** What a provider reads, but the names no run is handed. */
  const reads = (id, { table, asked }) => [...new Set([...table, ...asked, ...(id === "amazon-bedrock" ? BEDROCK : [])])].filter((name) => !(name in NOT_HANDED));
  const unlisted = Object.entries(keys).flatMap(([id, read]) => reads(id, read).filter((name) => !SECRET_NAMES.includes(name)).map((name) => `${id} ${name}`));
  assert.deepEqual(unlisted, [], "each is held as OPENAI_API_KEY is, so no environment holds it: add it to the launcher's SECRETS, or to NOT_HANDED with its reason");
  // And each is handed to a run on its provider's model: model.ts' PROVIDER_KEYS names every one under its provider,
  // and only providers pi-ai has, every name on the launcher's list.
  const unhanded = Object.entries(keys).flatMap(([id, read]) => reads(id, read).filter((name) => !(PROVIDER_KEYS[id] ?? []).includes(name)).map((name) => `${id} ${name}`));
  assert.deepEqual(unhanded, [], "add it to model.ts' PROVIDER_KEYS under its provider");
  assert.deepEqual(Object.keys(PROVIDER_KEYS).filter((id) => !(id in keys)), [], "a provider pi-ai does not have");
  assert.deepEqual(Object.values(PROVIDER_KEYS).flat().filter((name) => !SECRET_NAMES.includes(name)), [], "a provider's key the launcher does not hold");
  // A name no run is handed and named like a key is cut from every run's environment; a setting passes.
  assert.deepEqual(Object.keys(NOT_HANDED).filter((name) => keyShaped(name)), ["AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "GOOGLE_APPLICATION_CREDENTIALS"]);
});

/** A run of agent `id` (started, followed to its end) and what its process reported (faux-custody.mjs). */
const custodyReport = async (api, id) => {
  const { status, body } = await api("POST", `/agents/${id}/runs`, { input: { content: "Report." } });
  assert.equal(status, 202, JSON.stringify(body));
  await follow(api, body.run_id, ["completed"]);
  return { id: body.run_id, ...reported(body.run_id) };
};

/** Holds a turn of `runId` in its process, so the process is up while every process is read. */
async function holdTurn(api, runId) {
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Hold." })).status, 202);
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.state !== "working"; i++) {
    assert.ok(i < 200, "the held turn works");
    await sleep(50);
  }
  await sleep(500);
}

/** No process under `root` but `root` itself (the server, whose environment holds what its launcher was not told to
 *  take) holds `canary` in its environment or command line. */
function onlyTheServerHolds(root, canary) {
  const tree = treeOf(root);
  const under = processes().filter((p) => tree.has(p.pid) && p.pid !== root);
  for (const p of under) {
    assert.ok(!p.environ.includes(canary), `pid ${p.pid}'s environment holds a key-shaped variable no list names: ${p.cmdline.toString().replaceAll("\0", " ").slice(0, 120)}`);
    assert.ok(!p.cmdline.includes(canary), `pid ${p.pid}'s command line holds it`);
  }
  return under.map((p) => p.cmdline.toString().replaceAll("\0", " "));
}

/** The names of `names` shaped like a key (the one rule: the env cut's, the import cut's and pi-durable-disk's). */
const keyShapedIn = (names) => names.filter((name) => keyShaped(name));

test("under its launcher, with every secret set, a pi run is handed exactly its model's provider's key over its pipe (Gemini's, OpenRouter's, OpenAI's), no other, and none is in any process's environment, a run's, a program's it starts and a tool's program included; key-shaped names no list names (FOO_API_KEY, FOO_PASSWORD) reach no run", { timeout: 120_000 }, async (t) => {
  const { canary, secrets } = canaries();
  // Named like a key and on no list: the launcher cannot know to take them, so the server's environment keeps them; no
  // run's may. Their own canary: the server's environment holds them.
  const unlisted = `nak-unlisted-${process.pid}-${Date.now().toString(36)}`;
  const foo = `${unlisted}-FOO_API_KEY`;
  const password = `${unlisted}-FOO_PASSWORD`;
  // And names a key's segment makes one, wherever it is: none on a list.
  const more = Object.fromEntries(["SERVICE_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "DB_PASS", "GH_PAT", "MY_TOKEN_FILE", "FOO_TOKEN_BAR", "SENTRY_DSN", "DB_PWD"].map((name) => [name, `${unlisted}-${name}`]));
  const { root, api } = await launched(t, { ...secrets, FOO_API_KEY: foo, FOO_PASSWORD: password, ...more });
  // On the faux model whatever they name, as a faux run is: each is handed what a run on its model is handed, and its
  // model call answers.
  const models = { gemini: ["google/gemini-2.5-flash", "GEMINI_API_KEY"], openrouter: ["openrouter/anthropic/claude-sonnet-4.5", "OPENROUTER_API_KEY"], openai: ["openai/gpt-4o", "OPENAI_API_KEY"] };
  const reports = {};
  for (const [id, [model]] of Object.entries(models)) assert.equal((await api("POST", "/agents", agent(id, { model }))).status, 201);
  for (const [id, [, key]] of Object.entries(models)) {
    reports[id] = await custodyReport(api, id);
    assert.deepEqual(heldBy(reports[id].handed), [key], `a run on ${id}'s model is handed ${key} alone`);
    assert.equal(reports[id].handed[key], digest(secrets[key]), "over its pipe, whole");
  }
  for (const [id, report] of Object.entries(reports)) {
    assert.deepEqual(report.pipe, { fd: 3, closed: true }, "its pipe, fd 3, read and closed");
    for (const where of ["env", "child", "toolChild"]) {
      assert.deepEqual(report[where].filter((name) => SECRET_NAMES.includes(name) || ["FOO_API_KEY", "FOO_PASSWORD", ...Object.keys(more)].includes(name)), [], `no secret's name in ${where} of the run on ${id}`);
      assert.deepEqual(keyShapedIn(report[where]), [], `no key-shaped name at all in ${where}`);
    }
  }
  // The run on Gemini's model up, holding its turn, while every process of this user is read.
  await holdTurn(api, reports.gemini.id);
  const seen = noSecretAnywhere(root, canary);
  assert.ok(seen.some((cmdline) => cmdline.includes(" --app ")), "the run's process is among those read");
  for (const value of [foo, password, ...Object.values(more)]) onlyTheServerHolds(root, value);
});

/** Every file under `dir` (a run's directory: its store, process.log, harness/), and which holds any of `values`. The run is
 *  live while this reads it, so a file can go between its listing and its read: the run's launch mark (`launching`, empty)
 *  is removed once its process serves (F31, a queue ejection on 11-04). A file gone by its read holds nothing; any other read
 *  error still fails. `read` is the file reader, for the test below. */
function filesHolding(dir, ...values) { return filesHoldingWith(readFileSync, dir, ...values); }
function filesHoldingWith(read, dir, ...values) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(dir);
  const contents = (path) => { try { return read(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  return { files, holding: files.filter((path) => { const text = contents(path); return text !== null && values.some((value) => text.includes(value)); }) };
}

test("a run's file that goes between its listing and its read (its launch mark) holds nothing; a file that holds a key is still found, and another read error still fails", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "files-holding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "harness"));
  for (const [name, text] of [["launching", ""], ["process.log", "started"], ["harness/config.toml", "key = nak-canary"]]) writeFileSync(join(dir, name), text);
  const gone = (path) => { if (path.endsWith("/launching")) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" }); return readFileSync(path); };
  const { files, holding } = filesHoldingWith(gone, dir, "nak-canary");
  assert.equal(files.length, 3);
  assert.deepEqual(holding, [join(dir, "harness/config.toml")]);
  const denied = (path) => { throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" }); };
  assert.throws(() => filesHoldingWith(denied, dir, "nak-canary"), /EACCES/);
});

test("on codex, with every secret set and its turn held inside Codex's own process (a child of the run's), no process's environment holds a secret, Codex's included, which every command it starts inherits; key-shaped names no list names (FOO_API_KEY, FOO_PASSWORD) are in none under the server; and no file of the run's holds a key, its store, its log and Codex's own files included", { timeout: 120_000, skip: !CONFINED && "no setpriv" }, async (t) => {
  const { canary, secrets } = canaries();
  const unlisted = `nak-unlisted-codex-${process.pid}-${Date.now().toString(36)}`;
  const foo = `${unlisted}-FOO_API_KEY`;
  const password = `${unlisted}-FOO_PASSWORD`;
  const gw = await heldGateway(t);
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  copyFileSync(STAND_IN, standIn);
  const { root, api, data } = await launched(t, {
    ...secrets,
    FOO_API_KEY: foo,
    FOO_PASSWORD: password,
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: gw.origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_PRICE: "1,2,0.5",
  }, []);
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  const started = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(started.status, 202);
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 400, "Codex's model request reaches the gateway");
    await sleep(100);
  }
  assert.equal(gw.seen[0].authorization, `Bearer ${secrets.AGENT_MODEL_API_KEY}`, "the gateway's key reached Codex's request through the run's proxy");
  const seen = noSecretAnywhere(root, canary);
  assert.ok(seen.some((cmdline) => cmdline.includes(standIn)), `Codex's process is among those read: ${seen.map((c) => c.slice(0, 60)).join(" | ")}`);
  assert.ok(seen.some((cmdline) => cmdline.includes(" --app ")), "and the run's, Codex's parent");
  for (const value of [foo, password]) assert.ok(onlyTheServerHolds(root, value).some((cmdline) => cmdline.includes(standIn)), "neither holds a key-shaped variable no list names");
  // Everything the run has kept by its model request, read for a key while Codex holds the turn: its store, its log and
  // Codex's own files (its home, its config, its rollout).
  const { files, holding } = filesHolding(join(data, "runs", started.body.run_id), canary, unlisted);
  assert.ok(files.some((path) => path.endsWith("process.log")) && files.some((path) => path.includes("/harness/")), `the run's log and Codex's files are among those read: ${files.length} files`);
  assert.deepEqual(holding, [], "no file of the run's holds a key");
});

test("a pi run on Amazon Bedrock hands each request the AWS keys its process holds, in pi-ai's own env option, which Bedrock's request reads them from: none needs an environment", async () => {
  const { runModels } = await import("../dist/model.js");
  const { createProvider } = await import("@earendil-works/pi-ai/models");
  const canary = `not-a-secret-aws-${process.pid}`;
  const keys = Object.fromEntries(BEDROCK.map((name) => [name, `${canary}-${name}`]));
  // As the run's process holds its secrets (secrets.ts' withSecrets): read by name, never listed.
  const env = { AGENT_MODEL: "amazon-bedrock/amazon.nova-lite-v1:0" };
  for (const [name, value] of Object.entries(keys)) Object.defineProperty(env, name, { value, enumerable: false });
  const { models, model } = await runModels(env, undefined);
  // Bedrock's own provider and auth, its request taken here: what pi-ai would send Bedrock's request with.
  const real = models.getProvider("amazon-bedrock");
  let given;
  const take = (_model, _context, options) => {
    given = options?.env;
    throw new Error("taken");
  };
  models.setProvider(createProvider({ id: real.id, name: real.name, auth: real.auth, models: real.getModels(), api: { stream: take, streamSimple: take } }));
  const chat = models.getModel(model.provider, model.modelId);
  await models.streamSimple(chat, { messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }] }, {}).result().catch(() => undefined);
  assert.deepEqual(Object.fromEntries(BEDROCK.map((name) => [name, given?.[name] === keys[name]])), Object.fromEntries(BEDROCK.map((name) => [name, true])), "each AWS key reached Bedrock's request");
  given = undefined;
  await models.completeSimple(chat, { messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }] }, {}).catch(() => undefined);
  assert.equal(given?.AWS_SECRET_ACCESS_KEY, keys.AWS_SECRET_ACCESS_KEY, "and a completion's");
});

test("under its launcher, a workflow run's judges get the TypeSafe and Parallel keys the server holds, and no process holds either in its environment or command line", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "jev-calls.jsonl");
  const parallelCalls = join(dir, "parallel-calls.jsonl");
  const token = `not-a-secret-token-${process.pid}-${"t".repeat(24)}`;
  // The server as the launcher's COMMAND, with the tests' fake Jev and Parallel: the launcher hands it its secrets over
  // the pipe.
  const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const { secret } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const server = await startServe({ data: process.argv[1], port: 0, token: secret("AGENTRUN_TOKEN"), faux: ${JSON.stringify(FAUX)}, fauxJev: ${JSON.stringify(FAUX_JEV)}, fauxParallel: ${JSON.stringify(FAUX_PARALLEL)}, drainTimeout: "5s" });
process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");`;
  const { root, api } = await launched(t, { AGENTRUN_TOKEN: token, TYPESAFE_API_KEY: JEV_CANARY, PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: parallelCalls }, (data) => ["--", process.execPath, "--input-type=module", "-e", script, data]);
  const coi = {
    v: 2, name: "coi-check",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is \`doc\` a certificate of incorporation?" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Coi", path: "coi" },
    root: { node: "chain", steps: [{ node: "judge", label: "coi-parallel", state: { doc: "{question}" }, out: "Coi", as: "coi_parallel", provider: "parallel" }, { node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("coi", coi))).status, 201);
  const { body: started } = await api("POST", "/agents/coi/runs", { input: { question: "State of Delaware. Certificate of Incorporation of Example Widgets, Inc." } });
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const run = (await api("GET", `/runs/${started.run_id}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.result.output, { is_coi: true });
  const sent = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.authorized), [true], "Jev answered on the key the server holds, handed on the decision descriptor");
  const parallelSent = readFileSync(parallelCalls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(parallelSent.map((call) => call.authorized), [true], "and Parallel on its own");
  // The launcher's own processes only: the tests' keys are every decision test's canaries, and another file's server,
  // started with it in its environment, may be running now.
  const tree = treeOf(root);
  const ours = processes().filter((p) => tree.has(p.pid));
  assert.ok(ours.length >= 1, "the server is found");
  for (const p of ours) {
    for (const key of [JEV_CANARY, PARALLEL_CANARY]) {
      assert.ok(!p.environ.includes(key), `pid ${p.pid}'s environment holds a key: ${p.cmdline.toString().replaceAll("\0", " ").slice(0, 120)}`);
      assert.ok(!p.cmdline.includes(key), `pid ${p.pid}'s command line holds a key`);
    }
  }
});

test("under its launcher, with OPENROUTER_API_KEY its only decision key, a workflow run's Jev judge answers on that key through OpenRouter", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "jev-calls.jsonl");
  const token = `not-a-secret-token-${process.pid}-${"t".repeat(24)}`;
  // The server as the launcher's COMMAND, with the tests' fake Jev. OPENROUTER_API_KEY is on the launcher's list, so the
  // server and each run's process hold it with their secrets, never in their environment.
  const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const { secret } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const server = await startServe({ data: process.argv[1], port: 0, token: secret("AGENTRUN_TOKEN"), faux: ${JSON.stringify(FAUX)}, fauxJev: ${JSON.stringify(FAUX_JEV)}, drainTimeout: "5s" });
process.stdout.write("AGENTRUN_BASE_URL=" + server.baseUrl + "\\n");`;
  // No TypeSafe key anywhere the launcher could take one from: OpenRouter is Jev's only route.
  const typesafe = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => typesafe !== undefined && (process.env.TYPESAFE_API_KEY = typesafe));
  const env = { AGENTRUN_TOKEN: token, OPENROUTER_API_KEY: JEV_CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls };
  const { api } = await launched(t, env, (data) => ["--", process.execPath, "--input-type=module", "-e", script, data]);
  const coi = {
    v: 2, name: "coi-check",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is \`doc\` a certificate of incorporation?" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Coi", path: "coi" },
    root: { node: "chain", steps: [{ node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("coi", coi))).status, 201);
  const { body: started } = await api("POST", "/agents/coi/runs", { input: { question: "State of Delaware. Certificate of Incorporation of Example Widgets, Inc." } });
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const run = (await api("GET", `/runs/${started.run_id}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const sent = (existsSync(calls) ? readFileSync(calls, "utf8") : "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => [call.path, call.authorized]), [["/api/v1/systemone", true]], "one System One request to OpenRouter, on the key the server holds");
});

test("the launcher run through a link, as a package manager installs a bin, finds the server beside its real path", async (t) => {
  const dir = await scratch(t);
  const link = join(dir, "agentrun-serve");
  symlinkSync(LAUNCHER, link);
  const child = spawn(link, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: dir, AGENT_MODEL_API_KEY: `not-a-secret-${"help"}` } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  // "close", not "exit": it comes once the child's stdout and stderr are read to their end, so what it said is in.
  const code = await new Promise((resolve) => child.once("close", resolve));
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
  return { seen, release: () => release(), origin: `http://127.0.0.1:${server.address().port}` };
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
  const child = spawn(LAUNCHER, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmp, XDG_CONFIG_HOME: tmp, AGENT_MODEL_API_KEY: `not-a-secret-${"x".repeat(5_000)}` } });
  let out = "";
  child.stderr.on("data", (chunk) => (out += chunk));
  // "close", not "exit": "exit" can come before the stderr pipe is read, and the refusal would read as "".
  const code = await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(10_000).then(() => "hung")]);
  assert.equal(code, 1, out);
  assert.match(out, /more than the 4096 a pipe is sure to hold/);
});

test("a secret is handed over byte for byte, never read as shell: one full of shell syntax runs nothing, and reaches the run whole", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const token = `not-a-secret-${"token"}-${process.pid}-${"t".repeat(24)}`;
  // Command substitution, backticks, a separator, quotes and spaces, then enough to come near the 4096-byte limit.
  const hostile = `not-a-secret-$(touch ${join(dir, "PWNED")})\`touch ${join(dir, "PWNED2")}\`;x 'y "z ${"k".repeat(3_600)}`;
  // The gateway's key, which a run behind the gateway gets (under --faux its model answers, the gateway never asked).
  const { api } = await launched(t, { AGENTRUN_TOKEN: token, AGENT_MODEL_API_KEY: hostile, AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" });
  assert.equal((await api("POST", "/agents", { definition: { id: "bytes", version: 1, name: "bytes", instructions: "Answer.", skills: [], tools: [] } })).status, 201);
  const { body: run } = await api("POST", "/agents/bytes/runs", { input: { content: "Report." } });
  await follow(api, run.run_id, ["completed"]);
  const report = reported(run.run_id);
  assert.equal(report.handed.AGENT_MODEL_API_KEY, digest(hostile), "the run got it byte for byte");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("PWNED")), [], "nothing in it ran");
});
