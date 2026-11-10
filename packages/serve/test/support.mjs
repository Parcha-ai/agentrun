// A server on a fresh data directory with the faux model, and a client for its /v2 routes. No key, no network.
import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeAgentExecutable } from "@parcha/agentrun-harness-claude";
import { codexTarget } from "../../run-adapters-codex/dist/binary.js";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { startServe } from "../dist/index.js";
import { dockerPathsForRuns } from "../dist/box-paths.js";
import { fauxEnvOf } from "../dist/server.js";
import { readRunDbSync } from "../dist/run-db.js";
import { resolve } from "node:path";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { dispatchRunner } from "../dist/runner/harness-loops.js";
import { computerDepsFrom } from "../dist/workspace/index.js";
import { routeOf } from "../dist/runner/model-route.js";
import { FAUX_ENV, withoutFaux } from "../dist/model.js";
import { SEAL_KEY_ENV } from "../dist/tool-keys.js";
import { ensureSealKey, sealKeyHome } from "../dist/seal-key.js";
import { secret } from "../dist/secrets.js";

// Every test process keeps the seal key a server makes at its first start (seal-key.ts) under a config home of its own,
// never this machine's ~/.config: a server never starts without one, and a test must write nothing outside its own dirs.
{
  const config = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-config-"));
  process.env.XDG_CONFIG_HOME = config;
  process.on("exit", () => rmSync(config, { recursive: true, force: true }));
}

/** The secret writes (secret-writes.ts registers them on the server) the client sends from the owner's session, as the
 *  console does: the token can't make one. A plane's tests add theirs with secretWritePath, and need no client of their
 *  own. A path here is matched under /v2, its query left off. */
export const SECRET_WRITE_PATHS = [
  { methods: ["PUT", "DELETE"], path: /^\/settings\/tool-keys\/[^/]+$/ },
  { methods: ["POST"], path: /^\/triggers$/ },
  { methods: ["POST"], path: /^\/triggers\/[^/]+\/secret$/ },
  { methods: ["PUT"], path: /^\/settings\/webhook$/ },
  // MCP (mcp-secret-writes.ts): a saved server's PUT (a token or headers it carries, or one that drops its credential)
  // and DELETE, a sign-in's start, and the private-network OAuth hosts.
  { methods: ["PUT", "DELETE"], path: /^\/settings\/mcp-servers\/[^/]+$/ },
  { methods: ["POST"], path: /^\/settings\/mcp-servers\/[^/]+\/oauth\/start$/ },
  { methods: ["PUT"], path: /^\/settings\/mcp-servers\/oauth\/private-hosts$/ },
  // Connecting and disconnecting a GitHub App (github-connection.ts), and forgetting a saved sign-in (sign-ins-secrets.ts).
  { methods: ["POST"], path: /^\/integrations\/github\/connect$/ },
  { methods: ["DELETE"], path: /^\/integrations\/github$/ },
  { methods: ["DELETE"], path: /^\/agents\/[^/]+\/sign-ins\/[^/]+$/ },
];
/** Adds a secret write the client sends from the owner's session (`methods` on `path`, a RegExp over the /v2 path). */
export const secretWritePath = (methods, path) => void SECRET_WRITE_PATHS.push({ methods, path });
const secretWrite = (method, path) => SECRET_WRITE_PATHS.some((write) => write.methods.includes(method) && write.path.test(path.split("?")[0]));
/** The owner's password the client sets on a server that has none yet, to make a secret write from its session. */
const CLIENT_OWNER_PHRASE = `client-owner-${createHash("sha256").update(String(process.pid)).digest("hex").slice(0, 24)}`;
/** Each server's owner session cookie, by its base URL: set once, when the client first makes a secret write. */
const ownerCookies = new Map();

export const FAUX = new URL("./fixtures/faux-model.mjs", import.meta.url).pathname;

// No test reaches a box provider: the boxes the environment running the suite lists are not the tests'. A server here,
// or one a test starts in a process of its own, probes none, Docker included (on by default when AGENTRUN_BOXES is not
// set, boxes.ts): a test that wants a box lists it itself, with its endpoint on loopback (boxes.test.mjs), or unsets the
// setting over a fake docker (docker-by-default.test.mjs).
process.env.AGENTRUN_BOXES = "none";
// No test reaches npm's registry: a server whose data holds no Claude Code or Codex would install it on first use
// (harness-install.ts) from the registry npm is configured for. A test that installs names its own fake (fake-npm.mjs);
// any other such install fails at once on this closed port rather than downloading a CLI.
for (const name of ["npm_config_registry", "NPM_CONFIG_REGISTRY"]) process.env[name] = "http://127.0.0.1:9/";
// And gives up there at once: no retry with npm's backoff, a short timeout, so a test can never wait on such an install.
for (const [name, value] of [["fetch_retries", "0"], ["fetch_timeout", "5000"]]) for (const spelling of [`npm_config_${name}`, `NPM_CONFIG_${name.toUpperCase()}`]) process.env[spelling] = value;

/** The store's bytes on disk (the DB and its WAL and shared-memory sidecars), concatenated, for a sealed-at-rest check that
 *  a secret is never written in the clear: a committed write may still sit in the -wal before a checkpoint, so all three are
 *  read. The store's rows seal every secret (store/seal.ts), so none of these bytes holds a value in the clear. */
export function storeBytes(data) {
  return Buffer.concat(["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"].map((name) => { try { return readFileSync(join(data, name)); } catch { return Buffer.alloc(0); } }));
}

/** The records of a log another process appends to (a line of JSON each, as the fake docker's): only its whole lines,
 *  each ended by its newline. A file just made and still empty, or a last line still being written, is read as the
 *  records before it, never parsed half. None when there is no file. */
export function jsonLines(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Scratch directories, removed once this file's tests are done. node:test runs a test's after-hooks in the order they
 *  were added, so a removal added as a directory is made would run before the stop of a server or child started in it
 *  afterwards, while that process still writes there (ENOTEMPTY). At the file's end every test's stops have run. */
const scratchDirs = new Set();
// Added as this module loads, so it is the file's own hook (one added inside a test would be that test's).
after(() => Promise.all([...scratchDirs].map((dir) => writableTree(dir).then(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))));

export async function scratch(_t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  // Writable first, when it goes: a first use leaves its harness read-only (harness-install.ts).
  scratchDirs.add(dir);
  return dir;
}

/** Every directory under `dir` (no link followed) made writable by its owner, so the tree can be removed. A directory
 *  that goes while the walk is in it (a server still closing, or a fake box's command, removes its own spool) is already
 *  removed: it is passed over, never a failure. `fs`: the three calls it makes (a test's seam). */
export async function writableTree(dir, fs = { lstat, chmod, readdir }) {
  const gone = (error) => {
    if (error.code !== "ENOENT") throw error;
  };
  const st = await fs.lstat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return;
  if ((await fs.chmod(dir, st.mode | 0o700).then(() => true, gone)) !== true) return;
  const names = await fs.readdir(dir).catch(gone);
  for (const name of names ?? []) await writableTree(join(dir, name), fs);
}

/** Resolves once `child`, a server in a process of its own, has printed a whole line on stdout that `ready` matches (the
 *  line it prints once it listens); rejects as soon as it exits or cannot be spawned, with what it printed. A slow start
 *  on a loaded machine is still a start: the backstop is only for a child that neither prints the line nor exits. */
export function printed(child, ready, { backstopMs = 120_000 } = {}) {
  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    const settle = (error) => {
      clearTimeout(backstop);
      child.stdout.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("close", onClose);
      child.off("error", settle);
      if (error) reject(error);
      else resolve(out);
    };
    const onOut = (chunk) => {
      out += chunk;
      if (ready.test(out.slice(0, out.lastIndexOf("\n") + 1))) settle();
    };
    const onErr = (chunk) => (err = (err + chunk).slice(-8_000));
    // "close", not "exit": by then its stdout and stderr are read to their end, so its last words are in the message.
    const onClose = (code, signal) => settle(new Error(`the server exited (${signal ?? code}) before it printed ${ready}: ${out}${err}`));
    const backstop = setTimeout(() => settle(new Error(`the server printed no ${ready} in ${backstopMs / 1000} s and has not exited: ${out}${err}`)), backstopMs);
    backstop.unref();
    child.stdout.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.once("close", onClose);
    child.once("error", settle);
  });
}

/** The index.html of a built console, as Vite writes it: one module script and one stylesheet, both relative. */
export const CONSOLE_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>AgentRun</title>
<script type="module" crossorigin src="./assets/index-Ab12Cd34.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-Ef56Gh78.css"></head>
<body><div id="root"></div></body></html>
`;

/** A built console for test `t` (`startServe({ console })`): CONSOLE_INDEX and its assets, in `<scratch>/console`. */
export async function builtConsole(t) {
  const dir = await scratch(t);
  const root = join(dir, "console");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), CONSOLE_INDEX);
  await writeFile(join(root, "assets", "index-Ab12Cd34.js"), "document.getElementById('root').textContent = 'console';\n");
  await writeFile(join(root, "assets", "index-Ef56Gh78.css"), "body { margin: 0; }\n");
  await writeFile(join(root, "assets", "mono-latin-400-normal-Ij90Kl12.woff2"), Buffer.from("wOF2"));
  return root;
}

/** The packages the first-use installs put into `<data>/harnesses/<harness>` (harness-install.ts), linked there from this
 *  repository's own (the Claude Agent SDK, a dev dependency, with its CLI's platform package and the MCP library; Codex's
 *  launcher with this platform's binary package), so a server on `data` runs claude-agent and codex as one where both are
 *  installed, with no npm. `cli`: the file Claude's platform package holds as its CLI instead (one off its pins, or a
 *  path where nothing is); `codexBin`, the same for Codex's binary; `codex: false` leaves Codex out. A harness whose pinned
 *  CLI is not here is left out. */
export async function linkHarnesses(data, { cli, codex = true, codexBin } = {}) {
  const from = fileURLToPath(new URL("../../../node_modules/", import.meta.url));
  const link = (target, path) => symlink(target, path).catch((error) => (error.code === "EEXIST" ? undefined : Promise.reject(error)));
  const pinned = claudeAgentExecutable();
  if (pinned) {
    const to = join(data, "harnesses", "claude-agent", "node_modules");
    const platform = `@anthropic-ai/${basename(dirname(pinned))}`;
    for (const name of ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk", ...(cli ? [] : [platform])]) {
      await mkdir(dirname(join(to, name)), { recursive: true });
      await link(join(from, name), join(to, name));
    }
    if (cli) {
      // Its own file in the tree, as an install would leave it (one that is not there is a tree without its CLI).
      await mkdir(join(to, platform), { recursive: true });
      await writeFile(join(to, platform, "package.json"), readFileSync(join(from, platform, "package.json")));
      if (existsSync(cli)) await copyFile(cli, join(to, platform, basename(pinned)));
    }
  }
  const target = codexTarget();
  if (codex && target && existsSync(join(from, "@openai", `codex-${target.pkg}`))) {
    const to = join(data, "harnesses", "codex", "node_modules");
    const platform = `@openai/codex-${target.pkg}`;
    for (const name of ["@openai/codex", ...(codexBin ? [] : [platform])]) {
      await mkdir(dirname(join(to, name)), { recursive: true });
      await link(join(from, name), join(to, name));
    }
    if (codexBin) {
      // Its own file in the tree, as an install would leave it (one that is not there is a tree without its binary).
      const bin = join(to, platform, "vendor", target.target, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(to, platform, "package.json"), readFileSync(join(from, platform, "package.json")));
      if (existsSync(codexBin)) await copyFile(codexBin, join(bin, "codex"));
    }
  }
}

/** A data directory for test `t` holding Claude Code and Codex as the first-use installs put them (linkHarnesses), for a
 *  test that makes an adapter itself (adapters.ts claudeOf, codexOf, which load from the data their env names). */
export async function harnessData(t) {
  const data = await scratch(t);
  await linkHarnesses(data);
  return data;
}

/** The servers started on each data directory serve() made (a restart's, `serve(t, { data: first.data })`), by that
 *  directory: its owner's after-hook closes them before it removes the directory. */
const sharing = new Map();

/** Each data directory's trigger store (createServer's `store`), shared by every server serve() starts on it (a restart
 *  reads the triggers the first one made) and closed once the last of them has stopped. */
const stores = new Map();
async function storeFor(data) {
  let held = stores.get(data);
  if (!held) {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-"));
    held = { store: await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" }), dir, servers: 0 };
    stores.set(data, held);
  }
  held.servers += 1;
  return held;
}
async function storeDone(data, held) {
  held.servers -= 1;
  if (held.servers > 0 || stores.get(data) !== held) return;
  stores.delete(data);
  await held.store.close();
  await rm(held.dir, { recursive: true, force: true });
}

/** `store` as a test server's triggers see it: a trigger's agent is put in the store first when it is not there, since
 *  until the cutover the server keeps its agents in its own files and the store holds only what the triggers write. Test
 *  support only: the store itself refuses a trigger for an agent it does not hold (store-trigger-schema.test.mjs). */
function withAgents(store) {
  const ensure = async (agentId) => {
    if (typeof agentId === "string" && !(await store.agents.get(agentId))) await store.agents.put({ id: agentId, name: agentId });
  };
  const triggers = new Proxy(store.triggers, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "create") return async (trigger, ...rest) => (await ensure(trigger?.agentId), value.call(target, trigger, ...rest));
      if (key === "update") return async (id, patch, ...rest) => (await ensure(patch?.agentId), value.call(target, id, patch, ...rest));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // An agent archived through the server is archived in the store too, its row put first when it is not there.
  const agents = new Proxy(store.agents, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "archive") return async (id, ...rest) => (await ensure(id), value.call(target, id, ...rest));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The trigger settings too: the GitHub App is kept there (server.ts, sealed-settings-store.ts).
  return { triggers, runs: store.runs, agents, liveViewers: store.liveViewers, triggerSettings: store.triggerSettings, flush: () => store.flush() };
}

/** Trigger stores handed to servers a test starts itself (startServe, not serve()): closed when the file's tests are done,
 *  after every server a test closes in its own hooks. */
const loose = [];
after(async () => {
  for (const { store, dir } of loose.splice(0)) {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
/** A store for a server a test starts with startServe (`{ ...options, store: await triggerStore() }`), as serve() gives its
 *  own: the triggers' rows, a trigger's agent put there first. `of`: the same store again for a restart on the same data. */
export async function triggerStore(of) {
  if (of) return of;
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-"));
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  loose.push({ store, dir });
  return withAgents(store);
}

/** A server for test `t`, stopped after it, before its scratch directory goes. On the real models (`faux: undefined`) its
 *  data holds Claude Code and Codex as the first-use installs put them (linkHarnesses; `harnesses: { cli, codex }` to vary
 *  them); `harnesses` says so for any server, `false` for none. */
/** Starts an in-process runner beside a test's server on the same data directory, with its own store handle (role runner),
 *  so a run the server starts is claimed and run as the CLI start's server-and-runner runs it. Its loop is the runner's
 *  dispatch (dispatch.ts): each claim's launch picks its harness loop — pi on the kernel's adapter loop with the run's pi
 *  spec, a learning run on the learning loop, its model route the faux model under `faux`. Returns a close() that stops the
 *  runner and closes its store handle. */
export async function startInProcessRunner(data, { faux, githubApi, githubMcpOrigin, ...switches } = {}) {
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  // The runner's env mirrors the server's faux (model.ts FAUX_ENV): its model route reads the faux model from it, so a run
  // never reaches the network. The seal key is the server's (seal-key.ts), read as the CLI's runner reads it: the one
  // handed over, else the one kept under this process's config home. It seals the live-viewer tokens the browser writes.
  // Its tools' fakes and its harness table too, as the server hands a run's process its own (server.ts fauxEnvOf): each
  // the test gave its server (fauxMonid, fauxParallel, fauxJev, harnessTable…).
  const env = { ...withoutFaux(process.env), ...(faux ? fauxEnvOf({ ...switches, faux }) : {}) };
  const sealKey = ensureSealKey(secret(SEAL_KEY_ENV), { configHome: sealKeyHome(process.env) }).key;
  // The run's claim-time computer, composed once the one way (workspace/computer-deps.ts computerDepsFrom): none for the
  // runner's place, the real kinds otherwise, keys read from this env then the store's sealed rows; a Docker computer's
  // mounts by where the Docker has the data directory, as the CLI's runner reads it (box-paths.ts dockerPathsForRuns).
  const computers = computerDepsFrom({ env, store, sealKey, dockerPaths: () => dockerPathsForRuns(env, data) });
  let runner;
  try {
    runner = startRunner({
      store,
      // A test's fake GitHub, the server's githubApi seam: the runner mints the App's tokens there (never from the env). Its
      // fake GitHub MCP, the server's githubMcpOrigin seam: a github_app server there is the runner's GitHub MCP too.
      createLoop: dispatchRunner({ env, data, journal: (claim) => store.journal(claim), store, sealKey, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps, ...(githubApi ? { githubApi } : {}), ...(githubMcpOrigin ? { githubMcpOrigin } : {}) }),
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  return async () => {
    await runner.close().catch(() => {});
    await store.close().catch(() => {});
  };
}

export async function serve(t, { harnesses: asked, runner: wantRunner = true, ...options } = {}) {
  const harnesses = asked ?? (Object.hasOwn(options, "faux") && options.faux === undefined);
  const dir = options.data ? undefined : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  const data = options.data ?? join(dir, "agents");
  if (harnesses) await linkHarnesses(data, harnesses === true ? {} : harnesses);
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", ...options });
  // A runner beside the server on the same data (the CLI start's server-and-runner): it claims and runs what the server
  // starts, so a test reads a run that runs, not one that queues forever. `runner: false` leaves it off for a test that
  // wants the server alone. Its loop is the switch's dispatch (learning wired; pi/workflow the server's own, E2r).
  const closeRunner = wantRunner === false ? undefined : await startInProcessRunner(data, { ...options, faux: Object.hasOwn(options, "faux") ? options.faux : FAUX });
  // A handle of the test's own on the server's store (as a runner's), for what a test reads of its rows: server.store.
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  // A server on another's data (a restart's): its owner's hook closes it before the directory goes.
  if (dir) sharing.set(data, new Set());
  else sharing.get(data)?.add(server);
  // Under a fake docker (fixtures/fake-docker.mjs), a box command that asked for sudo fails the test: the stand-in refused
  // it, and noted it here.
  const dockerState = process.env.FAKE_DOCKER_STATE;
  t.after(async () => {
    // The runner releases its claims and closes its store handle before the server's directory goes.
    if (closeRunner) await closeRunner();
    await store.close().catch(() => {});
    await server.close();
    // The servers a test started on this one's data close before it goes: node:test runs after-hooks in the order they
    // were added, so this one runs before theirs, and a directory removed under a server still writing there fails with
    // ENOTEMPTY (and a hook that throws skips the rest, their closes among them, so the file hangs).
    if (dir) {
      for (const other of sharing.get(data) ?? []) await other.close();
      sharing.delete(data);
    }
    const sudo = dockerState ? (await import("./fixtures/sudo-stand-in.mjs")).sudoStandIn(dockerState).calls() : [];
    if (dir) await writableTree(dir).then(() => rm(dir, { recursive: true, force: true }));
    if (sudo.length) throw new Error(`a box command ran sudo on this machine (the stand-in refused it): ${sudo.join("; ")}`);
  });
  return { ...server, data, store, api: client(server.baseUrl, server.token) };
}

/** `server`'s client with every request sent from the owner's session (ownerSessionOf), as the console sends it: the
 *  password session with accounts on, the launch link's console with accounts off on loopback. */
export const asOwner = (server) => client(server.baseUrl, server.token, { owner: true });
/** The owner's session the test client holds for `server` (ownerSessionOf: its cookie and origin), for a request a test
 *  sends itself as the console does (an approval's answer): one owner per server, never a second password. */
export const clientOwnerSession = (server) => ownerSessionOf(server.baseUrl, server.token);

export function client(baseUrl, token, { owner = false } = {}) {
  /** A request on a connection of its own, which nothing reuses: a pooled socket the server closes is not its failure. */
  const fresh = (method, path) =>
    new Promise((resolve, reject) => {
      const req = request(`${baseUrl}${path}`, { method, agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk) => (text += chunk)).on("end", () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([name, value]) => [name, String(value)])), body: json ?? text });
        });
      });
      req.once("error", reject).end();
    });
  return Object.assign(api, { fresh });
  /** `raiseCheck: false`: no raise guard read after this request (raisedReadsQueued), for a test whose server goes away
   *  once the raise is answered. */
  async function api(method, path, body, headers = {}, { raiseCheck = true } = {}) {
    // A secret write goes from the owner's session, as the console's does (secret-writes.ts): the token is refused one.
    const session = (owner || secretWrite(method, path)) && !headers.authorization ? await ownerSessionOf(baseUrl, token) : undefined;
    const sent = { body };
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: session
        ? { "content-type": "application/json", cookie: session.cookie, origin: session.origin, ...headers }
        : { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: sent.body === undefined ? undefined : JSON.stringify(sent.body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    budgetSaysItsLeast(json, `${method} ${path}`);
    if (raiseCheck && method === "PATCH" && res.status === 200 && json?.resumed === true) await raisedReadsQueued(baseUrl, token, path);
    return { status: res.status, headers: res.headers, body: json ?? text };
  };
}

/** The owner's session on the server at `baseUrl` (its /v2), for the client's secret writes. With accounts on, the client
 *  sets the owner's password the first time, with its token standing in for the setup code (so on any server, its setup
 *  open or not), or signs in with it on a server it set up before a restart; with accounts off, it follows the launch link
 *  (`/?token=`, the 303 that sets the console's cookie), whose console is the owner's on a loopback server
 *  (secret-writes.ts). Where none works (an owner the test set up with its own password) it throws, saying so: a secret
 *  write never falls back to the token, which the server refuses; such a test makes its own owner's session. */
async function ownerSessionOf(baseUrl, token) {
  // By address and token: a server started again on a port another used has its own owner and cookie.
  const known = `${baseUrl} ${token ?? ""}`;
  if (ownerCookies.has(known)) return ownerCookies.get(known);
  const origin = new URL(baseUrl).origin;
  const post = (path, headers = {}) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify({ password: CLIENT_OWNER_PHRASE }) });
  const tried = [];
  const answer = async (what, res) => (tried.push(`${what}: ${res.status}`), res);
  let res = await answer("setup", await post("/setup", token ? { authorization: `Bearer ${token}` } : {}));
  if (res.status !== 201) res = await answer("sign-in", await post("/auth/sign-in"));
  if (res.status !== 200 && res.status !== 201 && token) res = await answer("launch link", await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: "manual" }));
  const cookie = [200, 201, 303].includes(res.status) ? res.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ") : "";
  if (!cookie) throw new Error(`the test client has no owner's session on ${baseUrl} for a secret write (${tried.join(", ")}): the token never writes a secret, so a test whose owner has its own password signs in itself`);
  const session = { cookie, origin };
  ownerCookies.set(known, session);
  return session;
}

/** A guard on every pause a test reads: a run paused at its cap that serves its figures serves `least_cap_usd` with them,
 *  the very cap its words name ("Raise the cap to at least $X", runs.ts budgetPending), so the figure and the sentence are
 *  never apart. A pause serves its figures whole or not at all (no refusal mark: none). */
function budgetSaysItsLeast(body, where) {
  const pendings = [body?.pending, ...(Array.isArray(body?.runs) ? body.runs.map((run) => run?.pending) : [])];
  for (const pending of pendings) {
    if (pending?.kind !== "budget" || pending.spent_usd === undefined) continue;
    const named = Number(/Raise the cap to at least \$(\d+\.\d\d)\b/.exec(pending.said ?? "")?.[1]);
    assert.equal(pending.least_cap_usd, named, `${where}: least_cap_usd is the cap its words name: ${JSON.stringify(pending)}`);
  }
}

/** A guard on every raise a test makes: a raise that resumed a paused run (PATCH /runs/{id}, `resumed: true`) leaves it
 *  reading as a run that goes on, at once. Never input_required with no pending, which `agentrun runs wait` and the
 *  client's runs.wait take as a run that needs someone; its follow-up turn is still to go (runs.ts statusOf). */
async function raisedReadsQueued(baseUrl, token, path) {
  if (!/^(?:\/v2)?\/runs\/[^/?]+$/.test(path)) return;
  const run = await (await fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
  assert.ok(!(run?.status === "input_required" && run?.pending === null), `PATCH ${path} resumed the run, which then reads input_required with no pending: ${JSON.stringify(run)}`);
}

export const agent = (id, extra = {}) => ({ definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools: [], ...extra } });

/** A workflow of one model node: `answer` extracts `{answer: number}` from the input's `question`. */
export const answerFlow = (instructions = "Answer the question.") => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions, out: "Answer", as: "answer" }] },
});

/** A workflow agent `id`: its definition carries `workflow` in place of instructions. */
export const flowAgent = (id, workflow = answerFlow(), extra = {}) => ({ definition: { id, name: id, workflow, ...extra } });

/** A run's v2 state from the stored kernel state and an ended run's outcome (mirrors store-reads/runs.ts stateOf): a plain
 *  completion reads 'completed', an escalation 'escalated', stopped and failed their own, anything not yet ended 'running'. */
const runViewState = (state, outcome) =>
  state === "ended" ? (outcome === "escalated" ? "escalated" : "completed")
  : state === "stopped" ? "stopped"
  : state === "failed" ? "failed"
  : "running";
const isoOf = (ms) => new Date(ms).toISOString();

/** The server's view row for run `runId`, read from the server's own store (the one it writes; opened read-only so it
 *  coexists with the server's owner, as runRecordOf does), in the v2 shape the old per-run store gave: state, revision,
 *  kind, cost, summary and times. Undefined for an unknown run. */
export function storeRun(data, runId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    const run = db.prepare("SELECT id, agent_id, revision_id, state, cost_usd, summary, outcome, imported_from, started_at, ended_at, archived_at FROM runs WHERE id = ?").get(runId);
    if (!run) return undefined;
    const rev = db.prepare("SELECT kind FROM revisions WHERE id = ?").get(run.revision_id);
    const agent = db.prepare("SELECT archived_at FROM agents WHERE id = ?").get(run.agent_id);
    const archivedAt = run.archived_at ?? agent?.archived_at ?? null;
    const imported = run.imported_from ? JSON.parse(run.imported_from) : null;
    return {
      id: run.id,
      agent: run.agent_id,
      revision: run.revision_id,
      kind: rev?.kind ?? "agentic",
      state: runViewState(run.state, run.outcome),
      startedAt: isoOf(run.started_at),
      ...(run.ended_at !== null ? { endedAt: isoOf(run.ended_at) } : {}),
      ...(run.cost_usd !== null ? { costUsd: run.cost_usd } : {}),
      ...(run.summary !== null ? { summary: run.summary } : {}),
      ...(archivedAt !== null ? { archivedAt: isoOf(archivedAt) } : {}),
      ...(imported ? { importedFrom: { source: imported.source, session: imported.session } } : {}),
    };
  } finally {
    db.close();
  }
}

/** Run `runId` as its claim and its process say it: the record the process keeps in its store (its status, `detail` and
 *  the epoch it ran under as `generation`), and its holder from the run's row — the runner that claimed it, whose name the
 *  runner mints as `<hostname>:<pid>:<uuid>` (runner.ts), so its `pid` is the process now running it; `{}` when there is
 *  neither yet. */
export function runRecordOf(data, runId) {
  let claim;
  try {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
    try {
      claim = db.prepare("SELECT epoch, runner FROM runs WHERE id = ?").get(runId);
    } finally {
      db.close();
    }
  } catch {
    claim = undefined;
  }
  let holder;
  if (typeof claim?.runner === "string") {
    const pid = Number(/:(\d+):[^:]+$/.exec(claim.runner)?.[1]);
    if (Number.isInteger(pid)) holder = { pid, runner: claim.runner };
  }
  let record = {};
  const file = join(runDir(data, runId), "store", "run.sqlite");
  if (existsSync(file)) {
    try {
      record = readRunDbSync(file, false, (db) => {
        const row = db.prepare("SELECT record FROM pda_run_status WHERE id = 1").get();
        return row ? JSON.parse(row.record) : {};
      });
    } catch {
      record = {};
    }
  }
  const { holder: _kept, ...rest } = record;
  return { ...rest, ...(holder ? { holder } : {}), ...(claim ? { epoch: Number(claim.epoch) } : {}) };
}

/** Create agent `id` and start one run of it with `content`. */
export async function startRun(api, id, content, extra = {}, skills) {
  assert.equal((await api("POST", "/agents", { ...agent(id, extra), ...(skills ? { skills } : {}) })).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}

/** Apply timeline pages from `after` the way a client must (drop, then upsert), until the run's status is in `until`: an end
 *  once its page is final, any other status on the first page that leaves no change behind it. */
export async function follow(api, runId, until, { after = 0, deadlineMs = 30_000 } = {}) {
  const view = new Map();
  const pages = [];
  const end = Date.now() + deadlineMs;
  for (;;) {
    // Each long poll on a connection of its own: a loaded machine's pooled socket closing under it is not the run's state.
    const { status, body: page } = await (api.fresh ?? api)("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
    assert.equal(status, 200, JSON.stringify(page));
    pages.push(page);
    if (page.reset) view.clear();
    for (const id of page.drop) view.delete(id);
    for (const row of page.rows) view.set(row.id, row);
    after = page.next_after;
    // A page's status and its rows are read together, so a page with no more to come has every row up to that status. A
    // second, empty page to confirm it would only return when its long poll runs out.
    const settled = ["completed", "failed", "cancelled"].includes(page.status) ? page.final : !page.has_more;
    if (until.includes(page.status) && settled) break;
    assert.ok(Date.now() < end, `the run did not reach ${until.join("|")}: last ${page.status}/${page.state}`);
  }
  const rows = [...view.values()].sort((a, b) => a.seq - b.seq);
  return { rows, pages, after, last: pages.at(-1) };
}

/** An OpenAI Responses endpoint on loopback: every turn answers `text` and reports `tokens` input and output tokens.
 *  `asked` lists every request's method and path, `bodies` each POST's JSON body, `models` the model each asked for,
 *  `authorizations` each POST's authorization header.
 *  `incomplete`: each answer stops at its length instead (response.incomplete, max_output_tokens: pi's stopReason "length"). */
export async function responsesEndpoint(t, text, tokens, { incomplete = false } = {}) {
  const asked = [];
  const bodies = [];
  const models = [];
  const authorizations = [];
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (req.method === "POST") authorizations.push(req.headers.authorization ?? null);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      if (req.method === "POST") models.push(bodies.at(-1)?.model);
      const item = { type: "message", id: "msg_1", role: "assistant", status: incomplete ? "incomplete" : "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const usage = { input_tokens: tokens, output_tokens: tokens, total_tokens: 2 * tokens };
      const end = incomplete
        ? { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item], usage } }
        : { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        end,
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, bodies, models, authorizations };
}

/** Sets `vars` in this process's environment, which a server's runs inherit, for test `t`; the rest of `names` unset. */
export function withEnv(t, vars, names = Object.keys(vars)) {
  const all = [...new Set([...names, ...Object.keys(vars)])];
  const saved = Object.fromEntries(all.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of all) delete process.env[name];
  Object.assign(process.env, vars);
}

/** One raw request to the server on `port` (Host 127.0.0.1:port unless given): status, headers, text and parsed JSON. */
export function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  const sent = Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...headers }).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: sent }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", (error) => reject(Object.assign(error, { message: `${error.message} on ${method} ${path} (a reused socket: ${req.reusedSocket})` })));
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** The Cookie header for the cookies an answer set. */
export const cookieOf = (res) => (res.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; ");

/** Whether the server took run `runId` back: its row's claim is the server's, and its WAL is checkpointed. */
function takenBack(data, runId) {
  let holder;
  try {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 1_000 });
    try {
      holder = db.prepare("SELECT claim_holder FROM runs WHERE id = ?").get(runId)?.claim_holder;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
  if (holder !== "server") return false;
  // Its size read once: a checkpoint may remove the WAL between two looks.
  try {
    return statSync(join(runDir(data, runId), "store", "run.sqlite-wal")).size === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

/** Once the process that held run `runId` (its row's holder) has exited and the server took the run back: only then is
 *  the run's store free to read. A paused run's process marks itself released (sleeping) before it closes its store and
 *  exits, so its status is not that signal; the process gone is, as it is for the server (runs.ts, a run no longer live). */
export async function letGo(data, runId, { deadlineMs = 20_000 } = {}) {
  let pid;
  let gone;
  for (const end = Date.now() + deadlineMs; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const record = runRecordOf(data, runId);
    // The last process its row named: a take-back names the server in its place.
    pid = record.holder?.pid ?? pid;
    // A live server's take-back done (the claim is the server's, its WAL checkpointed), so a reader of its store meets no
    // lock; with no server to take it back (one killed), 5 s after its process went.
    if (takenBack(data, runId)) return;
    if (Number.isInteger(pid) && !processAlive(pid)) {
      gone ??= Date.now();
      if (Date.now() - gone > 5_000) return;
    }
    assert.ok(Date.now() < end, `the run's process did not exit: ${JSON.stringify(record)}`);
  }
}

/** Run `runId`'s folder on the disk of data directory `data`: `<data>/disk/agents/<agent>/runs/<run>`, its agent read from
 *  the run's row in store.sqlite (read-only). A run the store does not know yet gets a folder no run has. */
export function runDir(data, runId) {
  let agent;
  try {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
    try {
      agent = db.prepare("SELECT agent_id FROM runs WHERE id = ?").get(runId)?.agent_id;
    } finally {
      db.close();
    }
  } catch {}
  const folder = agent === undefined ? "unknown-agent" : `${agent.toLowerCase()}-${createHash("sha256").update(agent, "utf8").digest("hex").slice(0, 16)}`;
  return join(data, "disk", "agents", folder, "runs", runId);
}

/** The run folders' names on the disk of data directory `data`, across its agents' folders. */
export function runIds(data) {
  const agents = join(data, "disk", "agents");
  return (existsSync(agents) ? readdirSync(agents) : []).flatMap((agent) => (existsSync(join(agents, agent, "runs")) ? readdirSync(join(agents, agent, "runs")) : [])).sort();
}

/** Each agent's runs/ folder on the disk of data directory `data`. */
export function runsFolders(data) {
  const agents = join(data, "disk", "agents");
  return (existsSync(agents) ? readdirSync(agents) : []).map((agent) => join(agents, agent, "runs")).filter((folder) => existsSync(folder));
}

/** What a faux process noted in `file` as JSON (a held process's pid and where it held): null while the file does not
 *  exist, and while its JSON is not all in (an empty or partial read: a note being written), so a poll goes on. The faux
 *  processes write each note whole (writeWhole); this is the test's side of the same race. `read`: how the file is read
 *  (a test's stub). */
export async function jsonIn(file, read = (path) => readFile(path, "utf8")) {
  const text = await read(file).catch(() => null);
  if (text === null || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `file`'s JSON once a faux process has noted it (jsonIn), polled every 50 ms; fails saying `reaching` after `ms`. */
export async function writtenJson(file, reaching, { ms = 55_000, read } = {}) {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const value = await jsonIn(file, read);
    if (value !== null) return value;
    assert.ok(Date.now() < end, reaching);
  }
}
