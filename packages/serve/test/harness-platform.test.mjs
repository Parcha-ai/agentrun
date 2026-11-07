// A platform no CLI harness ships a build for: Codex's targets (agentrun-harness-codex's TARGETS) and the Claude CLI's
// platform packages (the ones the lock AgentRun ships names) leave it out. Such a harness is never installed there: it is
// unavailable from the start, saying so, never "installs on first use", and a run on it is refused at once, before any
// npm, temp directory or registry request, however often it is started. The platform here is stubbed (process.arch).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { codexTarget } from "../../run-adapters-codex/dist/binary.js";
import { Runs } from "../dist/runs.js";
import { agent, scratch, serve, withEnv } from "./support.mjs";
import { fakeNpmRegistry, npmOn, npmTarball, until } from "./fake-npm.mjs";

/** An arch no harness ships a build for, on any platform. */
const NO_BUILD = "ia32";
const SAYS = { codex: /no Codex build for this platform \([a-z0-9]+-ia32(?:-musl)?\)/, "claude-agent": /no Claude Code build for this platform \([a-z0-9]+-ia32(?:-musl)?\)/ };

/** process.arch as `arch` until the test ends. */
function stubArch(t, arch) {
  const real = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...real, value: arch });
  t.after(() => Object.defineProperty(process, "arch", real));
}

/** The model each harness needs, so that no key is what it lacks: a gateway for codex (nothing is sent to it), a key for
 *  Claude. */
const models = (t) => withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, ["AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "OPENAI_API_KEY", "CODEX_BIN", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE"]);

test("on a platform with no build, codex and claude-agent are unavailable for it from the start, a run on either is refused at once, and nothing is installed or asked of the registry, start after start", { timeout: 120_000 }, async (t) => {
  models(t);
  // npm, were it run, on a registry of its own: any install would ask it.
  const registry = await fakeNpmRegistry(t, {}, {});
  await npmOn(t, registry);
  stubArch(t, NO_BUILD);
  const { api, data } = await serve(t, { faux: undefined, harnesses: false });
  const offers = Object.fromEntries((await api("GET", "/capabilities")).body.harnesses.map((offer) => [offer.id, offer]));
  for (const id of ["codex", "claude-agent"]) {
    assert.equal(offers[id].available, false, `${id}: ${JSON.stringify(offers[id])}`);
    assert.match(offers[id].reason ?? "", SAYS[id], id);
    assert.equal(offers[id].installs, undefined, `${id} never says it installs on first use where it has no build`);
  }
  for (const [name, harness] of [["coder", "codex"], ["claude", "claude-agent"]]) {
    // Saving an agent on it starts no install either.
    const saved = await api("POST", "/agents", agent(name, { harness }));
    assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
    for (const attempt of [1, 2]) {
      const run = await api("POST", `/agents/${name}/runs`, { input: { content: "Say what you did." } });
      assert.equal(run.status, 409, `${harness} start ${attempt}: ${JSON.stringify(run.body)}`);
      assert.equal(run.body.error?.code, "agent_not_runnable");
      assert.match(run.body.error?.message ?? "", SAYS[harness], `${harness} start ${attempt}`);
    }
  }
  assert.deepEqual(registry.hits, [], "no registry request: no install was tried");
  const harnesses = join(data, "harnesses");
  assert.deepEqual(existsSync(harnesses) ? readdirSync(harnesses) : [], [], "no install directory, and no temp directory beside one");
});

// Codex's launcher at its pin and this platform's package (a stub binary: the install below never finishes), for a run
// left waiting on Codex's install by the server before.
const TARGET = codexTarget();
const made = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-platform-registry-"));
after(() => rmSync(made, { recursive: true, force: true }));
const CODEX = "@openai/codex";
const PIN = "0.164.0";
const launcher = { name: CODEX, version: PIN, bin: { codex: "bin/codex.js" }, optionalDependencies: { [`${CODEX}-${TARGET?.pkg}`]: `npm:${CODEX}@${PIN}-${TARGET?.pkg}` } };
const platformManifest = { name: CODEX, version: `${PIN}-${TARGET?.pkg}`, os: [process.platform], cpu: [process.arch] };
const codexPackages = () => ({
  [CODEX]: {
    versions: {
      [PIN]: { manifest: launcher, ...npmTarball(made, `${CODEX}-${PIN}`, { "package.json": JSON.stringify(launcher), "bin/codex.js": "#!/usr/bin/env node\n" }) },
      [`${PIN}-${TARGET.pkg}`]: { manifest: platformManifest, ...npmTarball(made, `${CODEX}-${PIN}-${TARGET.pkg}`, { "package.json": JSON.stringify(platformManifest), [`vendor/${TARGET.target}/bin/codex`]: "#!/bin/sh\necho codex-cli 0.164.0\n" }) },
    },
  },
});

test("a run left waiting on Codex's install, recovered on a platform with no build, ends failed with the no-build words, launched a bounded number of times, with no registry request", { timeout: 120_000, skip: !TARGET && "Codex ships no binary for this platform" }, async (t) => {
  models(t);
  const registry = await fakeNpmRegistry(t, codexPackages(), { [CODEX]: PIN });
  registry.hold(CODEX);
  await npmOn(t, registry);
  const data = join(await scratch(t), "agents");
  // The first server, on this platform: the run waits on the install, which the registry holds, and the server closes.
  const first = await serve(t, { faux: undefined, harnesses: false, harnessLocks: { codex: registry.lock }, data });
  assert.equal((await first.api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  const run = await first.api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await until("the run waits on Codex's install", async () => (await first.api("GET", `/runs/${run.body.run_id}/timeline`)).body.rows?.some((r) => r.kind === "phase" && /^Installing Codex/.test(r.summary ?? "")), 60_000);
  await first.close();
  const asked = registry.hits.length;
  // Every launch counted; past 50 the loop the fix ends is cut here, so a test of the bug fails on its count, not a hang.
  let launches = 0;
  const launch = Runs.prototype.launch;
  Runs.prototype.launch = function (...args) {
    launches += 1;
    if (launches <= 50) return launch.apply(this, args);
  };
  t.after(() => void (Runs.prototype.launch = launch));
  // The next server on the same data, on a platform Codex has no build for, recovers the run.
  stubArch(t, NO_BUILD);
  const next = await serve(t, { faux: undefined, harnesses: false, harnessLocks: { codex: registry.lock }, data });
  const ended = await until("the recovered run ends", async () => {
    const now = (await next.api("GET", `/runs/${run.body.run_id}`)).body;
    return ["failed", "completed", "cancelled"].includes(now.status) ? now : launches > 50 ? { status: `still ${now.status}, launched ${launches} times` } : undefined;
  }, 30_000);
  assert.equal(ended.status, "failed", JSON.stringify(ended));
  assert.match(ended.error?.message ?? "", SAYS.codex);
  assert.ok(launches <= 3, `launched ${launches} times`);
  assert.deepEqual(registry.hits.slice(asked), [], "no registry request on the platform with no build");
  await next.close();
});
