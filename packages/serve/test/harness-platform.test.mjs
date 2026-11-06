// A platform no CLI harness ships a build for: Codex's targets (agentrun-harness-codex's TARGETS) and the Claude CLI's
// platform packages (the ones the lock AgentRun ships names) leave it out. Such a harness is never installed there: it is
// unavailable from the start, saying so, never "installs on first use", and a run on it is refused at once, before any
// npm, temp directory or registry request, however often it is started. The platform here is stubbed (process.arch).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";
import { fakeNpmRegistry, npmOn } from "./fake-npm.mjs";

/** An arch no harness ships a build for, on any platform. */
const NO_BUILD = "ia32";
const SAYS = { codex: /no Codex build for this platform \([a-z0-9]+-ia32(?:-musl)?\)/, "claude-agent": /no Claude Code build for this platform \([a-z0-9]+-ia32(?:-musl)?\)/ };

/** process.arch as `arch` until the test ends. */
function stubArch(t, arch) {
  const real = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...real, value: arch });
  t.after(() => Object.defineProperty(process, "arch", real));
}

test("on a platform with no build, codex and claude-agent are unavailable for it from the start, a run on either is refused at once, and nothing is installed or asked of the registry, start after start", { timeout: 120_000 }, async (t) => {
  // A model for each, so that no key is what they lack: a gateway for codex (nothing is sent to it), a key for Claude.
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, ["AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "OPENAI_API_KEY", "CODEX_BIN", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE"]);
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
