// Each harness's binary is checked against its pins (its sha256, then its --version) once per binary per process: the
// start's probe of the harnesses, then a save and a run check of a codex revision, share one check of codex's binary and
// one of claude-agent's. Counted at the one call every check makes, `<binary> --version`: Node's own execFileSync,
// wrapped here (syncBuiltinESMExports carries the wrap to every module's named import of it). Since the start's probe is
// the one that makes the offers, a harness missing or off its pins then stays unavailable until a restart, and says so.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { agent, scratch, serve, withEnv } from "./support.mjs";
import { findOpenCode } from "../dist/harness-opencode/binary.js";

test("the start's probe of the harnesses, a save and a run check of a codex revision check each harness's binary once", { timeout: 120_000 }, async (t) => {
  // A gateway's model for codex (nothing is sent to it) and an Anthropic key for claude-agent: no real key.
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, ["AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "OPENAI_API_KEY", "CODEX_BIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE", "MONID_API_KEY"]);
  const asked = new Map();
  const real = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, ...rest) {
    if (Array.isArray(args) && args[0] === "--version" && ["codex", "claude"].includes(basename(String(file)))) asked.set(basename(String(file)), (asked.get(basename(String(file))) ?? 0) + 1);
    return real.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = real;
    syncBuiltinESMExports();
  });
  const { api } = await serve(t, { faux: undefined });
  const offers = (await api("GET", "/capabilities")).body.harnesses;
  const codex = offers.find((offer) => offer.id === "codex");
  if (!codex.available) return t.skip(`codex does not run here: ${codex.reason}`);
  // A save checks the revision's model on codex; its run is refused after the same check, for a tool this server lacks.
  const saved = await api("POST", "/agents", agent("coder", { harness: "codex", tools: ["monid.run"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", "/agents/coder/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error?.code, run.body.error?.details?.missing], [409, "agent_not_runnable", { "monid.run": ["MONID_API_KEY"] }]);
  const claude = offers.find((offer) => offer.id === "claude-agent");
  assert.deepEqual(Object.fromEntries(asked), { codex: 1, ...(claude.available || asked.has("claude") ? { claude: 1 } : {}) }, `each binary checked once (${JSON.stringify(offers.map((offer) => [offer.id, offer.available, offer.reason ?? null]))})`);
});

test("the start's probe, a save and a run check of an opencode revision check OpenCode's binary once: one --version and one read of its bytes", { timeout: 120_000 }, async (t) => {
  // The installed binary at a path of its own (a link named opencode in a fresh directory, given as OPENCODE_BIN): a check
  // is kept for the process by the binary's path, and this file's other test already checked the installed one, through
  // its probe of every harness. Here nothing has checked this path yet, so the count starts at none.
  const installed = findOpenCode();
  if (!installed) return t.skip("no OpenCode binary installed here");
  const dir = await mkdtemp(join(tmpdir(), "agentrun-opencode-once-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "opencode");
  await symlink(installed.path, bin);
  // A gateway's model for opencode (nothing is sent to it): no real key.
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", OPENCODE_BIN: bin }, ["AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "OPENAI_API_KEY", "AGENTRUN_SERVE_OPENCODE_STANDIN", "MONID_API_KEY"]);
  let asked = 0;
  let read = 0;
  const isOpenCode = (path) => path === bin;
  const real = { execFileSync: childProcess.execFileSync, openSync: fs.openSync, readFileSync: fs.readFileSync };
  childProcess.execFileSync = function (file, args, ...rest) {
    if (Array.isArray(args) && args[0] === "--version" && isOpenCode(String(file))) asked += 1;
    return real.execFileSync.call(this, file, args, ...rest);
  };
  // Its sha256, read a chunk at a time (an open) or whole (a read of the file): either counts as one read of its bytes.
  fs.openSync = function (path, ...rest) {
    if (isOpenCode(path)) read += 1;
    return real.openSync.call(this, path, ...rest);
  };
  fs.readFileSync = function (path, ...rest) {
    if (isOpenCode(path)) read += 1;
    return real.readFileSync.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(childProcess, { execFileSync: real.execFileSync });
    Object.assign(fs, { openSync: real.openSync, readFileSync: real.readFileSync });
    syncBuiltinESMExports();
  });
  const { api } = await serve(t, { faux: undefined });
  const opencode = (await api("GET", "/capabilities")).body.harnesses.find((offer) => offer.id === "opencode");
  if (!opencode.available) return t.skip(`opencode does not run here: ${opencode.reason}`);
  // A save checks the revision's model on opencode; its run is refused after the same check, for a tool this server lacks.
  const saved = await api("POST", "/agents", agent("opener", { harness: "opencode", tools: ["monid.run"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", "/agents/opener/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error?.code, run.body.error?.details?.missing], [409, "agent_not_runnable", { "monid.run": ["MONID_API_KEY"] }]);
  assert.deepEqual({ versions: asked, reads: read }, { versions: 1, reads: 1 }, "OpenCode's binary checked once: one --version, its bytes read once");
});

test("a harness whose binary is missing or off its pins at the start says to restart AgentRun once it is installed; one a setting fixes does not", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  // A codex and a claude that are not the pinned build: their sha256 is not the pin's.
  const unpinned = join(dir, "unpinned");
  await writeFile(unpinned, "#!/bin/sh\necho 0.0.1\n");
  await chmod(unpinned, 0o755);
  const keys = { OPENAI_API_KEY: `not-a-secret-${"openai"}`, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` };
  withEnv(t, keys, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "CODEX_BIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE"]);
  /** GET /v2/capabilities' harnesses by id, from a server started with `vars` set. */
  const offers = async (vars, claudeSdk = true) => {
    Object.assign(process.env, vars);
    const { api } = await serve(t, { faux: undefined, claudeSdk });
    return Object.fromEntries((await api("GET", "/capabilities")).body.harnesses.map((offer) => [offer.id, offer]));
  };
  const INSTALL = /; once it is installed, restart AgentRun to pick it up\.$/;
  const PINS = /; once the pinned build is installed, restart AgentRun\.$/;
  // Not installed: no file where each binary is named. Claude Code without its CLI is not whole: it installs again on
  // first use, so claude-agent runs and names no restart.
  const missing = await offers({ CODEX_BIN: join(dir, "nothing") }, { cli: join(dir, "nothing") });
  assert.equal(missing.codex.available, false, JSON.stringify(missing.codex));
  assert.match(missing.codex.reason, /is not installed/);
  assert.match(missing.codex.reason, INSTALL, "codex not installed: restart once it is installed");
  assert.deepEqual([missing["claude-agent"].available, missing["claude-agent"].installs, missing["claude-agent"].reason], [true, "on_first_use", undefined], "claude-agent's tree without its CLI installs again");
  // Off its pins: a binary that is not the pinned build.
  const off = await offers({ CODEX_BIN: unpinned }, { cli: unpinned });
  assert.match(off.codex.reason, /is not the pinned build/);
  assert.match(off.codex.reason, PINS, "codex off its pins: restart once the pinned build is installed");
  assert.equal(off["claude-agent"].available, false, JSON.stringify(off["claude-agent"]));
  assert.match(off["claude-agent"].reason, PINS, "claude-agent's CLI off its pins: the restart is named");
  // Claude Code not installed in the data at all: it installs on first use, so it runs, and names no restart.
  const fresh = await offers({}, false);
  assert.deepEqual([fresh["claude-agent"].available, fresh["claude-agent"].installs, fresh["claude-agent"].reason], [true, "on_first_use", undefined]);
  // A setting fixes it, and a save of a key checks the harnesses again (server.ts): no restart named.
  delete process.env.OPENAI_API_KEY;
  const keyless = await offers({ AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: unpinned }) });
  assert.deepEqual([keyless.codex.available, keyless.codex.reason], [false, "codex needs OPENAI_API_KEY, OPENROUTER_API_KEY (OpenAI's models through OpenRouter), or a gateway in AGENT_MODEL_BASE_URL."]);
});
