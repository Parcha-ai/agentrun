// Claude Code installs itself on first use: a claude-agent run on a server whose data holds no Claude Agent SDK installs the
// pinned one from npm into <data>/harnesses (one install at a time), shows it on the run while it does, and runs on it. The
// registry is a fake on loopback: it serves the SDK at the pin (and a later version it must not take), the MCP library as
// the SDK's peer and the CLI's platform package. Its SDK and MCP modules re-export this repository's own copies, and its
// CLI is the pinned binary itself, so a run that starts is a real Claude run against a fake Anthropic endpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { claudeAgentExecutable, CLAUDE_AGENT_SDK_VERSION } from "@parcha/agentrun-harness-claude";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, scratch, serve } from "./support.mjs";

const SDK = "@anthropic-ai/claude-agent-sdk";
const PIN = "0.3.286";
const LATER = "0.3.300";
const MCP = "@modelcontextprotocol/sdk";
const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
const INSTALLING = "Installing Claude Code (first use)…";
/** The pinned CLI this repository's tests run, and its platform package's name (`claude-agent-sdk-linux-x64`, say). */
const CLI = claudeAgentExecutable();
const PLATFORM = CLI ? `@anthropic-ai/${basename(dirname(CLI))}` : undefined;
const skip = (!CLI && "no pinned Claude CLI here") || (!existsSync("/usr/bin/setpriv") && "no setpriv here");

/** The command a person runs when the install fails, naming the data's harnesses directory. */
const manualLine = (data) => `npm install --prefix ${join(data, "harnesses")} ${SDK}@${PIN}`;
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
  const mcpManifest = { name: MCP, version: "1.32.2", type: "module", exports: { "./server/mcp.js": "./server/mcp.js", "./types.js": "./types.js" } };
  const cliManifest = { name: PLATFORM, version: PIN, os: [process.platform], cpu: [process.arch] };
  made = {
    [SDK]: { versions: { [PIN]: { manifest: sdkManifest, ...tarball(dir, SDK, { "package.json": JSON.stringify(sdkManifest), "sdk.mjs": reexport(SDK) }) } }, latest: LATER },
    [MCP]: { versions: { "1.32.2": { manifest: mcpManifest, ...tarball(dir, MCP, { "package.json": JSON.stringify(mcpManifest), "server/mcp.js": reexport(`${MCP}/server/mcp.js`), "types.js": reexport(`${MCP}/types.js`) }) } } },
    [PLATFORM]: { versions: { [PIN]: { manifest: cliManifest, ...tarball(dir, PLATFORM, { "package.json": JSON.stringify(cliManifest), claude: { link: CLI } }) } } },
  };
  // A later SDK, the registry's latest: listed, and its tarball is not there, so an install that took it fails.
  made[SDK].versions[LATER] = { manifest: { ...sdkManifest, version: LATER }, file: join(dir, "missing.tgz"), integrity: "sha512-AAAA" };
  return made;
}

/** An npm registry on loopback, on a port below the ephemeral range that it binds (so it was free). `hits` lists every
 *  path asked; `hold` keeps the SDK's tarball until it resolves; `missing` answers 404 to everything. */
async function fakeRegistry(t, { hold, missing = false } = {}) {
  const served = await packages();
  const hits = [];
  const server = createServer(async (req, res) => {
    hits.push(req.url);
    const path = decodeURIComponent(req.url.split("?")[0]).slice(1);
    const tgz = /^-\/(.+)\/(\d[^/]*)\.tgz$/.exec(path);
    if (!missing && tgz && served[tgz[1]]?.versions[tgz[2]] && existsSync(served[tgz[1]].versions[tgz[2]].file)) {
      if (tgz[1] === SDK && hold) await hold;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(served[tgz[1]].versions[tgz[2]].file));
    }
    const pkg = !missing && !tgz ? served[path] : undefined;
    if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    const versions = Object.fromEntries(Object.entries(pkg.versions).map(([version, { manifest, integrity }]) => [version, { ...manifest, dist: { tarball: `${url}/-/${path}/${version}.tgz`, integrity } }]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: path, "dist-tags": { latest: pkg.latest ?? Object.keys(versions)[0] }, versions }));
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
  return { url, hits, tarballs: () => hits.filter((hit) => decodeURIComponent(hit).startsWith(`/-/${SDK}/`)) };
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

/** A server on `data` (else a fresh directory) that holds no Claude Agent SDK, with an agent on claude-agent. */
async function firstUseServe(t, data) {
  const served = await serve(t, { faux: undefined, claudeSdk: false, ...(data ? { data } : {}) });
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
  const { api, data } = await firstUseServe(t);
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
  const first = await firstUseServe(t, data);
  const run = await first.api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal((await follow(first.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  assert.equal(installedIn(data), PIN, "the first run installed the SDK in <data>/harnesses");
  await first.close();
  const asked = registry.hits.length;
  const answered = anthropic.asked();
  // The same data under a new server.
  anthropic.hold();
  const second = await serve(t, { faux: undefined, claudeSdk: false, data });
  t.after(() => second.close());
  const again = await second.api("POST", "/agents/claude/runs", { input: { content: "Say hello again." } });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await until("the second run's model request reaches the endpoint", () => anthropic.asked() > answered);
  const paths = await cliPaths();
  anthropic.release();
  assert.deepEqual(paths, [join(data, "harnesses", "node_modules", ...PLATFORM.split("/"), "claude")], "the second run's CLI is the installed one");
  assert.equal((await follow(second.api, again.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 })).last.status, "completed");
  assert.deepEqual(registry.hits.slice(asked), [], "no registry request for the second run");
  await second.close();
});

test("a registry that fails ends the run with the one command that installs Claude Code by hand", { timeout: 180_000, skip }, async (t) => {
  const registry = await fakeRegistry(t, { missing: true });
  const anthropic = await anthropicEndpoint(t);
  await firstUseEnv(t, registry, anthropic.fake);
  const { api, data } = await firstUseServe(t);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.ok(String(view.error?.message ?? "").includes(manualLine(data)), `the run's error names the manual install: ${JSON.stringify(view.error)}`);
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
  const { api } = await firstUseServe(t);
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
  const { api } = await firstUseServe(t);
  const offer = async () => (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent");
  // The agent's create started the install, held at the SDK's tarball: until it is in, the offer says it installs on first use.
  const before = await offer();
  assert.equal(before.installs, "on_first_use", JSON.stringify(before));
  assert.equal(before.available, true, JSON.stringify(before));
  letGo();
  const after = await until("capabilities no longer say it installs on first use", async () => ((await offer()).installs === undefined ? offer() : undefined), 240_000);
  assert.equal(after.available, true, JSON.stringify(after));
});
