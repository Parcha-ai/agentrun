// Claude Code installs itself on first use: a claude-agent run on a server whose data holds no Claude Agent SDK installs the
// pinned one from npm into <data>/harnesses (one install at a time), shows it on the run while it does, and runs on it. The
// registry is a fake on loopback: it serves the SDK at the pin (and a later version it must not take), the MCP library as
// the SDK's peer and the CLI's platform package. Its SDK and MCP modules re-export this repository's own copies, and its
// CLI is the pinned binary itself, so a run that starts is a real Claude run against a fake Anthropic endpoint.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { claudeAgentExecutable, CLAUDE_AGENT_SDK_VERSION } from "@parcha/agentrun-harness-claude";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, client, follow, scratch, serve } from "./support.mjs";

const SDK = "@anthropic-ai/claude-agent-sdk";
const PIN = "0.3.286";
const LATER = "0.3.300";
const MCP = "@modelcontextprotocol/sdk";
/** A release of the MCP library newer than the one in the locks (fakeRegistry's `later`). */
const LATE_MCP = "1.99.0";
const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
const INSTALLING = "Installing Claude Code (first use)…";
/** The pinned CLI this repository's tests run, and its platform package's name (`claude-agent-sdk-linux-x64`, say). */
const CLI = claudeAgentExecutable();
const PLATFORM = CLI ? `@anthropic-ai/${basename(dirname(CLI))}` : undefined;
const skip = (!CLI && "no pinned Claude CLI here") || (!existsSync("/usr/bin/setpriv") && "no setpriv here");

/** The command a person runs when the install fails, naming the data's harnesses directory. */
/** The command a person runs when the install fails, as the server installs: the lock's package.json and lock copied into
 *  a fresh directory beside the data's harnesses, `npm ci` there with no install script, then that directory put in place
 *  of the harnesses (made writable first: the server leaves its install read-only). `lock`: the lock the server installs by. */
const manualLine = (data, lock) => {
  const dir = join(data, "harnesses");
  const next = `${dir}.new`;
  return `rm -rf ${next} && mkdir -p ${next} && cp ${join(dirname(lock), "package.json")} ${lock} ${next}/ && npm ci --prefix ${next} --ignore-scripts --include=optional && (chmod -R u+w ${dir} 2>/dev/null || true) && rm -rf ${dir} && mv ${next} ${dir}`;
};
/** The SDK's version as installed in the data's harnesses, or undefined. */
const installedIn = (data) => {
  try {
    return JSON.parse(readFileSync(join(data, "harnesses", "node_modules", ...SDK.split("/"), "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};

/** A gzipped npm tarball of `files` (path → text, or `{ link }` to a file put in whole), and its integrity. */
function tarball(dir, name, files) {
  const root = join(dir, name.replace("/", "+"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "package", path)), { recursive: true });
    if (typeof text === "string") writeFileSync(join(root, "package", path), text);
    else symlinkSync(text.link, join(root, "package", path));
  }
  const file = `${root}.tgz`;
  // -h puts a linked file in whole; gzip -1, as the CLI is 230 MB.
  execFileSync("sh", ["-c", 'tar -chf - -C "$1" package | gzip -1 > "$2"', "sh", root, file]);
  const bytes = readFileSync(file);
  return { file, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

/** The packages the fake registry serves, made once per file, in a directory the file removes at its end. */
let made;
let madeIn;
after(() => madeIn && rm(madeIn, { recursive: true, force: true }));
async function packages() {
  if (made) return made;
  const dir = (madeIn = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-registry-")));
  const reexport = (specifier) => `export * from ${JSON.stringify(import.meta.resolve(specifier))};\n`;
  const sdkManifest = { name: SDK, version: PIN, type: "module", main: "sdk.mjs", exports: { ".": { default: "./sdk.mjs" } }, peerDependencies: { [MCP]: "^1.29.0" }, optionalDependencies: { [PLATFORM]: PIN } };
  // Its install script leaves a mark where SCRIPT_MARKER names (when set): no install of AgentRun's ever runs it.
  const mcpManifest = { name: MCP, version: "1.32.2", type: "module", exports: { "./server/mcp.js": "./server/mcp.js", "./types.js": "./types.js" }, scripts: { postinstall: "node -e \"process.env.SCRIPT_MARKER && require('fs').writeFileSync(process.env.SCRIPT_MARKER, 'ran')\"" } };
  const cliManifest = { name: PLATFORM, version: PIN, os: [process.platform], cpu: [process.arch] };
  made = {
    [SDK]: { versions: { [PIN]: { manifest: sdkManifest, ...tarball(dir, SDK, { "package.json": JSON.stringify(sdkManifest), "sdk.mjs": reexport(SDK) }) } }, latest: LATER },
    [MCP]: { versions: { "1.32.2": { manifest: mcpManifest, ...tarball(dir, MCP, { "package.json": JSON.stringify(mcpManifest), "server/mcp.js": reexport(`${MCP}/server/mcp.js`), "types.js": reexport(`${MCP}/types.js`) }) } } },
    [PLATFORM]: { versions: { [PIN]: { manifest: cliManifest, ...tarball(dir, PLATFORM, { "package.json": JSON.stringify(cliManifest), claude: { link: CLI } }) } } },
  };
  // A later MCP library, published only once a test's lock is made (fakeRegistry's `later`).
  const lateMcp = { ...mcpManifest, version: LATE_MCP };
  made[MCP].versions[LATE_MCP] = { manifest: lateMcp, ...tarball(dir, `${MCP}-late`, { "package.json": JSON.stringify(lateMcp), "server/mcp.js": reexport(`${MCP}/server/mcp.js`), "types.js": reexport(`${MCP}/types.js`) }) };
  // A later SDK, the registry's latest: listed, and its tarball is not there, so an install that took it fails.
  made[SDK].versions[LATER] = { manifest: { ...sdkManifest, version: LATER }, file: join(dir, "missing.tgz"), integrity: "sha512-AAAA" };
  return made;
}

/** An npm registry on loopback, on a port below the ephemeral range that it binds (so it was free), and the lock of the
 *  install as AgentRun ships it for the real registry (`lock`, made by npm against this one, before any test's request):
 *  `hits` lists every path asked after it; `hold` keeps the SDK's tarball until it resolves, `holdMcp` the MCP
 *  library's; `missing` answers 404 to everything; `tamper` serves other bytes for that package's tarball than the lock
 *  names. */
async function fakeRegistry(t, { hold, holdMcp, ...given } = {}) {
  // How it answers once the lock is made; `answer` changes it.
  const mode = { missing: false, tamper: undefined, later: undefined, ...given };
  const served = await packages();
  const hits = [];
  let ready = false;
  const server = createServer(async (req, res) => {
    hits.push(req.url);
    const path = decodeURIComponent(req.url.split("?")[0]).slice(1);
    const tgz = /^-\/(.+)\/(\d[^/]*)\.tgz$/.exec(path);
    const gone = ready && mode.missing;
    if (!gone && tgz && served[tgz[1]]?.versions[tgz[2]] && existsSync(served[tgz[1]].versions[tgz[2]].file)) {
      if (tgz[1] === SDK && hold) await hold;
      if (tgz[1] === MCP && holdMcp) await holdMcp;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Tampered: another package's bytes, which npm reads as this one's, against the lock's sha512.
      return res.end(readFileSync(served[ready && mode.tamper === tgz[1] ? SDK : tgz[1]].versions[ready && mode.tamper === tgz[1] ? PIN : tgz[2]].file));
    }
    const pkg = !gone && !tgz ? served[path] : undefined;
    if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    // `later`: once the lock is made, a newer release of that package is published (the registry's latest, a range in the
    // tree takes it): a well-formed tarball with its own sha512, as a compromised release would be.
    const published = Object.fromEntries(Object.entries(pkg.versions).filter(([version]) => version !== LATE_MCP || (ready && mode.later === path)));
    const versions = Object.fromEntries(Object.entries(published).map(([version, { manifest, integrity }]) => [version, { ...manifest, dist: { tarball: `${url}/-/${path}/${version}.tgz`, integrity } }]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: path, "dist-tags": { latest: versions[LATE_MCP] ? LATE_MCP : (pkg.latest ?? Object.keys(versions)[0]) }, versions }));
  });
  let port;
  for (let tries = 0; ; tries++) {
    port = 20000 + Math.floor(Math.random() * 12000);
    const bound = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) break;
    assert.ok(tries < 50, "a free port below 32768 for the fake registry");
  }
  const url = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // The lock, as the release makes AgentRun's: npm's own, for a package.json that names the SDK at the pin alone.
  const dir = await scratch(t);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "agentrun-claude-code", private: true, dependencies: { [SDK]: PIN } }, null, 2)}\n`);
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));
  await new Promise((resolve, reject) => execFile("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${url}/`, `--cache=${join(dir, "cache")}`], { cwd: dir, env: npmEnv }, (error, stdout, stderr) => (error ? reject(new Error(`the lock: ${stderr}`)) : resolve())));
  hits.length = 0;
  ready = true;
  return { url, hits, lock: join(dir, "package-lock.json"), answer: (changes) => void Object.assign(mode, { missing: false, tamper: undefined, later: undefined }, changes), tarballs: () => hits.filter((hit) => decodeURIComponent(hit).startsWith(`/-/${SDK}/`)) };
}


/** The server's environment for test `t`: npm on `registry` with a cache of its own, Anthropic's endpoint the fake. */
async function firstUseEnv(t, registry, anthropic) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  // npm's settings in both spellings (npm reads either, and the uppercase one wins): a cache of the test's own, so no
  // install finds the SDK cached by an earlier one.
  for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) delete process.env[name];
  const npm = { registry: `${registry.url}/`, cache: join(await scratch(t), "npm-cache"), fetch_retries: "0", update_notifier: "false" };
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: `anthropic/${MODEL}` });
  for (const [name, value] of Object.entries(npm)) Object.assign(process.env, { [`npm_config_${name}`]: value, [`NPM_CONFIG_${name.toUpperCase()}`]: value });
}

/** A server on `data` (else a fresh directory) that holds no Claude Agent SDK, installing on `registry`'s lock (the test's
 *  stand-in for the one AgentRun ships), with an agent on claude-agent. */
async function firstUseServe(t, registry, data) {
  const served = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, ...(data ? { data } : {}) });
  assert.equal((await served.api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  return served;
}

/** A fake Anthropic endpoint that answers at once, or, once `hold()` was called, holds each answer until `release()`. */
async function anthropicEndpoint(t) {
  let gate;
  let release = () => {};
  const fake = await fakeAnthropic({ reply: () => (gate ? { hold: gate, then: { text: "Claude answered." } } : { text: "Claude answered." }) });
  t.after(() => (release(), fake.close()));
  return { fake, hold: () => void (gate = new Promise((resolve) => (release = resolve))), release: () => release(), asked: () => fake.messages().length };
}

/** This test's own descendant processes. */
async function descendants() {
  const out = [];
  const queue = [process.pid];
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

/** The Claude CLIs this test's descendants run, by the path each was started at. */
async function cliPaths() {
  const out = [];
  for (const pid of await descendants()) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    out.push(...argv.filter((arg) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(arg)));
  }
  return out;
}

const until = async (what, check, ms = 120_000) => {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, what);
  }
};

test("the pin is the one the harness package names", () => {
  assert.equal(CLAUDE_AGENT_SDK_VERSION, PIN);
});

test("the first claude-agent run installs exactly 0.3.286 into <data>/harnesses/ and starts on it", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t);
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  anthropic.hold();
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Mid-turn: the CLI that answers is the one installed in the data, never one beside the server.
  // Read once a model request is held: the CLI answering it, not the pin check's `claude --version`.
  await until("a model request reaches the endpoint", () => anthropic.asked() > 0, 240_000);
  const paths = await cliPaths();
  anthropic.release();
  assert.deepEqual(paths, [join(data, "harnesses", "node_modules", ...PLATFORM.split("/"), "claude")], "the run's CLI is the one installed in <data>/harnesses");
  assert.equal(installedIn(data), PIN, "the pinned SDK is installed in <data>/harnesses, not the registry's latest");
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.equal(rows.findLast((row) => row.kind === "final_answer")?.text, "Claude answered.");
  assert.equal(registry.tarballs().length, 1, `the SDK was fetched once: ${registry.tarballs().join(", ")}`);
});

test("a second run doesn't reinstall: on the same data, after a restart, it starts on the installed SDK with no registry request", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t);
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const data = join(await scratch(t), "agents");
  const first = await firstUseServe(t, registry, data);
  const run = await first.api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal((await follow(first.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  assert.equal(installedIn(data), PIN, "the first run installed the SDK in <data>/harnesses");
  await first.close();
  const asked = registry.hits.length;
  const answered = anthropic.asked();
  // The same data under a new server.
  anthropic.hold();
  const second = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, data });
  t.after(() => second.close());
  const again = await second.api("POST", "/agents/claude/runs", { input: { content: "Say hello again." } });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await until("the second run's model request reaches the endpoint", () => anthropic.asked() > answered);
  const paths = await cliPaths();
  anthropic.release();
  assert.deepEqual(paths, [join(data, "harnesses", "node_modules", ...PLATFORM.split("/"), "claude")], "the second run's CLI is the installed one");
  assert.equal((await follow(second.api, again.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 })).last.status, "completed");
  // A package's metadata or tarball, that is: npm's own requests for the registry's root ("/") are not an install's.
  assert.deepEqual(registry.hits.slice(asked).filter((hit) => hit !== "/"), [], "no registry request for the second run");
  await second.close();
});

test("a registry that fails ends the run with the one command that installs Claude Code by hand", { timeout: 180_000, skip }, async (t) => {
  const registry = await fakeRegistry(t, { missing: true });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.ok(String(view.error?.message ?? "").includes(manualLine(data, registry.lock)), `the run's error names the manual install: ${JSON.stringify(view.error)}`);
  assert.equal(last.status, "failed");
  assert.equal(installedIn(data), undefined);
});

test("while it installs, the run reads \"Installing Claude Code (first use)…\", and a second run waits for that install instead of starting its own", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const hold = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { hold });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api } = await firstUseServe(t, registry);
  const first = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const installing = async (id) => (await api("GET", `/runs/${id}/timeline`)).body.rows?.find((r) => r.kind === "phase" && r.summary === INSTALLING);
  await until("the run reads that it installs Claude Code", () => installing(first.body.run_id), 60_000);
  assert.equal((await api("GET", `/runs/${first.body.run_id}`)).body.status, "queued", "queued while it installs");
  const second = await api("POST", "/agents/claude/runs", { input: { content: "Say hello too." } });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await until("the second run reads that it installs Claude Code", () => installing(second.body.run_id), 60_000);
  await until("npm asks for the SDK's tarball, which is held", () => registry.tarballs().length > 0, 60_000).catch((error) => assert.fail(`${error.message}: the registry was asked ${registry.hits.join(", ")}`));
  assert.equal(registry.tarballs().length, 1, "one install: the SDK's tarball asked once, and held");
  letGo();
  for (const id of [first.body.run_id, second.body.run_id]) {
    const { rows, last } = await follow(api, id, ["completed", "failed"], { deadlineMs: 240_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
    assert.ok(!rows.some((r) => r.summary === INSTALLING), "the install's row goes once it is installed");
  }
  assert.equal(registry.tarballs().length, 1, "still one install");
});

test("capabilities say claude-agent installs on first use until it is installed", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const hold = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { hold });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api } = await firstUseServe(t, registry);
  const offer = async () => (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent");
  // The agent's create started the install, held at the SDK's tarball: until it is in, the offer says it installs on first use.
  const before = await offer();
  assert.equal(before.installs, "on_first_use", JSON.stringify(before));
  assert.equal(before.available, true, JSON.stringify(before));
  letGo();
  const after = await until("capabilities no longer say it installs on first use", async () => ((await offer()).installs === undefined ? offer() : undefined), 240_000);
  assert.equal(after.available, true, JSON.stringify(after));
});

/** The SDK's package.json wherever an install under `data` put it: in its harnesses, or in any directory beside them. */
async function sdkAnywhere(data) {
  const roots = [join(data, "harnesses"), ...(await readdir(data).catch(() => [])).filter((name) => name.startsWith(".harnesses")).map((name) => join(data, name))];
  return roots.map((root) => join(root, "node_modules", ...SDK.split("/"), "package.json")).find((file) => existsSync(file));
}

/** This test's descendant processes running an npm install (the one server's of this test, on `data`), by pid. */
async function npmOn(data) {
  const out = [];
  for (const pid of await descendants()) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    // npm names itself by its command once it runs (its process title: "npm ci", "npm install …"), past its argv.
    if (/^npm (ci|install)\b/.test(argv.join(" ")) || (argv.includes("--prefix") && argv.some((arg) => arg.startsWith(data)))) out.push(pid);
  }
  return out;
}

test("AgentRun ships the install's lock: the SDK at the pin, and every package of the tree, platform and transitive, by sha512", () => {
  const file = new URL("../harnesses/claude-agent/package-lock.json", import.meta.url);
  assert.ok(existsSync(file), "serve ships harnesses/claude-agent/package-lock.json");
  assert.deepEqual(JSON.parse(readFileSync(new URL("../harnesses/claude-agent/package.json", import.meta.url), "utf8")).dependencies, { [SDK]: CLAUDE_AGENT_SDK_VERSION }, "and the package.json it locks");
  const lock = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, { [SDK]: CLAUDE_AGENT_SDK_VERSION }, "the root names the SDK at the pin, and nothing else");
  assert.equal(lock.packages[`node_modules/${SDK}`].version, CLAUDE_AGENT_SDK_VERSION);
  const entries = Object.entries(lock.packages).filter(([path]) => path);
  for (const name of [PLATFORM, MCP]) assert.ok(lock.packages[`node_modules/${name}`], `the lock holds ${name}`);
  assert.deepEqual(entries.filter(([, entry]) => !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")).map(([path]) => path), [], "every package by its sha512");
});

test("a tarball whose bytes are not the lock's fails the install, names the command that installs it by hand, and leaves nothing installed", { timeout: 180_000, skip }, async (t) => {
  const registry = await fakeRegistry(t, { tamper: MCP });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(installedIn(data), undefined, "no SDK installed from a tarball off the lock");
  assert.equal(await sdkAnywhere(data), undefined, "nor one left beside the harnesses");
  assert.equal(last.status, "failed");
  assert.ok(String(view.error?.message ?? "").includes(manualLine(data, registry.lock)), `the run's error names the manual install: ${JSON.stringify(view.error)}`);
});

test("a release of a package in the tree published after the lock is not taken: the install is the lock's, version for version", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t, { later: MCP });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  const mcp = JSON.parse(readFileSync(join(data, "harnesses", "node_modules", ...MCP.split("/"), "package.json"), "utf8"));
  assert.equal(mcp.version, "1.32.2", "the MCP library at the lock's version, not the release published after it");
  assert.ok(!registry.hits.some((hit) => decodeURIComponent(hit) === `/-/${MCP}/${LATE_MCP}.tgz`), "its tarball never asked");
});

test("an install killed part way leaves nothing that reads as installed, and the next run installs Claude Code whole", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const holdMcp = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { holdMcp });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  // The agent's create starts the install; the MCP library's tarball is held, so npm has the SDK and waits.
  const { api, data } = await firstUseServe(t, registry);
  await until("npm writes the SDK somewhere under the data", () => sdkAnywhere(data), 120_000);
  const pids = await until("npm runs on the data", async () => ((await npmOn(data)).length ? npmOn(data) : undefined), 30_000).catch(async (error) => assert.fail(`${error.message}: ${(await Promise.all((await descendants()).map(async (pid) => (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").join(" ").slice(0, 200)))).join(" | ")}`));
  for (const pid of pids) process.kill(pid, "SIGKILL");
  await until("npm is gone", async () => (await npmOn(data)).length === 0, 30_000);
  letGo();
  assert.equal(installedIn(data), undefined, "a killed install leaves no SDK that reads as installed");
  // The cut install's directory goes as that install ends; a run started after it installs anew.
  await until("the cut install is cleared away", async () => (await sdkAnywhere(data)) === undefined, 30_000);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.equal(installedIn(data), PIN);
});

/** The command a run's failed install names, as its error gives it. */
const manualOf = (message) => /Install it by hand with: (.*); then run the agent again\./.exec(message)?.[1];

test("the manual command the error names installs as the server does: the lock's tree, version for version, and no package's install script", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t, { missing: true });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  const line = manualOf(String((await api("GET", `/runs/${run.body.run_id}`)).body.error?.message ?? ""));
  assert.ok(line, "the error names a command");
  // The person's registry answers now, and has published a later MCP library since the lock.
  registry.answer({ later: MCP });
  const marker = join(await scratch(t), "script-ran");
  // Not execFileSync: the registry answers from this process.
  await new Promise((resolve, reject) => execFile("sh", ["-c", line], { env: { ...process.env, SCRIPT_MARKER: marker } }, (error, stdout, stderr) => (error ? reject(new Error(`${line}: ${stderr}`)) : resolve())));
  assert.equal(existsSync(marker), false, "no package's install script ran");
  assert.equal(JSON.parse(readFileSync(join(data, "harnesses", "node_modules", ...MCP.split("/"), "package.json"), "utf8")).version, "1.32.2", "the lock's MCP library, not the later release");
  assert.equal(installedIn(data), PIN);
});

test("a server that closes while it installs stops npm and waits for it before it lets go of its data; nothing is left installed, and the next server installs whole", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const holdMcp = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { holdMcp });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const data = join(await scratch(t), "agents");
  const { close } = await firstUseServe(t, registry, data);
  await until("npm runs on the data", async () => (await npmOn(data)).length > 0, 120_000);
  await close();
  // Gone before the server let go of its data: no npm of the first server's writes beside the next one.
  assert.deepEqual(await npmOn(data), [], "npm has exited before close() returned");
  assert.equal(installedIn(data), undefined);
  assert.equal(await sdkAnywhere(data), undefined, "nothing left beside the harnesses either");
  letGo();
  // The next server on the same data installs Claude Code whole, alone.
  const next = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, data });
  t.after(() => next.close());
  const run = await next.api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal((await follow(next.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  assert.equal(installedIn(data), PIN);
  await next.close();
});

test("a partial tree is not Claude Code: one whose MCP library would resolve from above it (the data's own node_modules) is installed again whole, and the run starts on that", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t);
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  // A data path with a space, which no part of the install may split.
  const data = join(await scratch(t), "agents here");
  const repo = new URL("../../../node_modules/", import.meta.url).pathname;
  // The SDK alone in the harnesses, with no CLI and no MCP library; the MCP library one level up, where a walk would find it.
  for (const [name, at] of [[SDK, join(data, "harnesses", "node_modules")], [MCP, join(data, "node_modules")]]) {
    mkdirSync(dirname(join(at, name)), { recursive: true });
    symlinkSync(join(repo, name), join(at, name));
  }
  const { api } = await firstUseServe(t, registry, data);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, `a partial tree does not make claude-agent unrunnable: ${JSON.stringify(run.body)}`);
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.equal(registry.tarballs().length, 1, "installed again: the SDK's tarball asked");
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.ok(existsSync(join(data, "harnesses", "node_modules", ...MCP.split("/"), "package.json")), "the MCP library is in the harnesses now");
});

test("runs that wait for the install keep their places: at max_concurrent_runs 1, a second run during the install is refused, so no two run at once after it", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const hold = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { hold });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api } = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  const first = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await until("the run waits for the install", async () => (await api("GET", `/runs/${first.body.run_id}/timeline`)).body.rows?.some((r) => r.kind === "phase" && r.summary === INSTALLING), 60_000);
  const second = await api("POST", "/agents/claude/runs", { input: { content: "Say hello too." } });
  assert.deepEqual([second.status, second.body.error?.code], [429, "rate_limited"], `the waiting run holds the one place: ${JSON.stringify(second.body)}`);
  letGo();
  assert.equal((await follow(api, first.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
});

test("the manual command replaces an install the server made, read-only as it left it: run as shown, it puts a whole install in its place", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t);
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal((await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  assert.equal(installedIn(data), PIN, "the server installed it");
  // The server's own line (the one its errors name), not this test's copy of it.
  const { installLine } = await import("../dist/claude-sdk.js");
  const line = installLine(join(data, "harnesses"), registry.lock);
  await new Promise((resolve, reject) => execFile("sh", ["-c", line], (error, stdout, stderr) => (error ? reject(new Error(`${line}: ${stderr}`)) : resolve())));
  assert.equal(installedIn(data), PIN);
  assert.ok(existsSync(join(data, "harnesses", "node_modules", ...MCP.split("/"), "package.json")), "a whole install: the MCP library too");
});

test("a run cancelled while it waits for the install gives its place back at once: at max_concurrent_runs 1, a pi run starts", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const hold = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { hold });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api } = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const waiting = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(waiting.status, 202, JSON.stringify(waiting.body));
  await until("the run waits for the install", async () => (await api("GET", `/runs/${waiting.body.run_id}/timeline`)).body.rows?.some((r) => r.kind === "phase" && r.summary === INSTALLING), 60_000);
  assert.equal((await api("POST", `/runs/${waiting.body.run_id}/cancel`)).status < 300, true, "cancelled");
  // The install still runs (held); the cancelled run's place is free now, not when it ends.
  const pi = await api("POST", "/agents/plain/runs", { input: { content: "Hi." } });
  assert.equal(pi.status, 202, `the place is free: ${JSON.stringify(pi.body)}`);
  letGo();
});

test("a server killed while it installs leaves its waiting run to the next server, which installs Claude Code first and resumes it, never running on a missing SDK", { timeout: 300_000, skip }, async (t) => {
  let letGo;
  const holdMcp = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const registry = await fakeRegistry(t, { holdMcp });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const dir = await scratch(t);
  const data = join(dir, "agents");
  // The first server in a process of its own, so a test can kill it as a crash would.
  const script = join(dir, "serve.mjs");
  writeFileSync(script, `import { startServe } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const served = await startServe({ data: ${JSON.stringify(data)}, port: 0, claudeLock: ${JSON.stringify(registry.lock)}, drainTimeout: "5s" });
console.log(JSON.stringify({ url: served.baseUrl, token: served.token }));
`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  t.after(() => void (child.exitCode === null && child.signalCode === null && child.kill("SIGKILL")));
  const first = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
    });
    child.once("exit", (code) => reject(new Error(`the first server exited (${code}) before it served`)));
  });
  const api = client(first.url, first.token);
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await until("npm runs on the data", async () => (await npmOn(data)).length > 0, 120_000);
  // The crash: npm first (it would outlive its server), then the server, with the run waiting on the install.
  for (const pid of await npmOn(data)) process.kill(pid, "SIGKILL");
  child.kill("SIGKILL");
  await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
  letGo();
  assert.equal(installedIn(data), undefined, "the crash left Claude Code uninstalled");
  // The next server recovers the run: it installs Claude Code before the run's process starts, and the run answers.
  const next = await serve(t, { faux: undefined, claudeSdk: false, claudeLock: registry.lock, data });
  const { rows, last } = await follow(next.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.equal(rows.findLast((row) => row.kind === "final_answer")?.text, "Claude answered.");
  assert.equal(installedIn(data), PIN);
  await next.close();
});

test("a person's npm config that omits optional packages still installs Claude Code's CLI: the install includes it", { timeout: 300_000, skip }, async (t) => {
  const registry = await fakeRegistry(t);
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  // As an .npmrc with omit=optional would say it (the CLI is the SDK's optional platform package).
  Object.assign(process.env, { npm_config_omit: "optional", NPM_CONFIG_OMIT: "optional" });
  const { api, data } = await firstUseServe(t, registry);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.ok(existsSync(join(data, "harnesses", "node_modules", ...PLATFORM.split("/"), "claude")), "the platform package's CLI is installed");
});
