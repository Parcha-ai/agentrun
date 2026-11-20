// A harness module's ACP agent (kit.acpEntry) on a server's run gets the adapter's allowlist environment and nothing
// else of the server's: the names it starts with are the allowlist's, its private folders', its recipe's and the
// session proxy's, and a variable planted in the server's environment, under a plain name or a key's, never reaches it.
// Names only are read; no value is written anywhere but the canary's own check.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const { AGENT_VARS } = await import("../dist/harness-recipe.js");
const ACP_INDEX = pathToFileURL(fileURLToPath(new URL("../../run-adapters-acp/dist/index.js", import.meta.url))).href;
const ACP_TESTING = pathToFileURL(fileURLToPath(new URL("../../run-adapters-acp/dist/testing.js", import.meta.url))).href;
const ID = "env-probe";
const MODEL = "anthropic/claude-haiku-4-5";
/** What a shell sets for itself (the wrapper is one): never the host's. */
const SHELL_OWN = ["PWD", "OLDPWD", "SHLVL", "_"];
/** The recipe's own literal variables. */
const RECIPE_ENV = { ENV_PROBE_MODE: "on" };

/** A module whose harness is kit.acpEntry over the fake ACP agent, started through `wrapper`. */
function probeModule(dir, wrapper) {
  const path = join(dir, "env-probe-module.mjs");
  writeFileSync(path, `import { gooseFacts, gooseProxy } from ${JSON.stringify(ACP_INDEX)};
import { fakeAgentRecipe } from ${JSON.stringify(ACP_TESTING)};
const facts = Object.freeze({ ...gooseFacts, id: ${JSON.stringify(ID)}, label: "Env probe" });
export const entries = (_builtins, kit) => ({ ${JSON.stringify(ID)}: kit.acpEntry({
  facts,
  recipe: (launch) => {
    const fake = fakeAgentRecipe(${JSON.stringify(ID)}, ${JSON.stringify(dir)}, [{ say: "PROBE_RAN" }], { load: true, http: true, style: "goose" });
    return { ...fake, command: ${JSON.stringify(wrapper)}, args: [process.execPath, ...fake.args], env: ${JSON.stringify(RECIPE_ENV)}, billing: { kind: "proxy" } };
  },
  proxy: (launch) => gooseProxy({ model: launch.model, provider: launch.provider, price: launch.price, log: launch.log }),
}) });\n`);
  return path;
}

test("a module's ACP agent on a server's run starts with the allowlist's names alone: a variable planted in the server's environment never reaches it", { skip: process.platform !== "linux" ? "the run's confinement is Linux's" : !existsSync("/usr/bin/setpriv") && "no setpriv here", timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const canary = `env-probe-canary-${process.pid}-${Date.now()}`;
  const names = join(dir, "names");
  const leaked = join(dir, "leaked");
  // The agent's process: it writes the names it was started with, notes whether the canary's value, or the server's model
  // key's, is in any of them (its ANTHROPIC_API_KEY is the session proxy's own), then runs the fake agent.
  const wrapper = join(dir, "agent.sh");
  writeFileSync(wrapper, `#!/bin/sh\nenv | cut -d= -f1 | sort -u > '${names}'\nif env | grep -qF -e '${canary}' -e 'fake-test-key'; then : > '${leaked}'; fi\nexec "$@"\n`);
  chmodSync(wrapper, 0o755);
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", AGENT_MODEL: MODEL, ENV_PROBE_CANARY: canary, ENV_PROBE_CANARY_API_KEY: canary });
  const { api } = await serve(t, { faux: undefined, harnessModules: [probeModule(dir, wrapper)] });
  assert.equal((await api("POST", "/agents", agent("prober", { harness: ID, model: MODEL }))).status, 201);
  const run = await api("POST", "/agents/prober/runs", { input: { content: "Follow the script." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.ok(existsSync(names), "the agent's process started");
  const started = readFileSync(names, "utf8").split("\n").filter(Boolean);
  const allowed = new Set([...Object.values(AGENT_VARS).flat(), ...Object.keys(RECIPE_ENV), ...SHELL_OWN]);
  assert.deepEqual(started.filter((name) => !allowed.has(name)), [], `beyond the allowlist: ${started.join(" ")}`);
  assert.ok(!started.some((name) => name.startsWith("ENV_PROBE_CANARY")), "the canary's names");
  assert.equal(existsSync(leaked), false, "the canary's value, or the server's model key, reached the agent");
});

/** The server's model keys a recipe of acpEntryOf's may never name in `keys` (harness-recipe.ts serverKey). */
const SERVER_MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];
/** A server's keys, fake: the model key a launch is chosen on is there, so only the recipe's keys can refuse it. */
const KEYED_ENV = { ANTHROPIC_API_KEY: "fake-test-key", OPENROUTER_API_KEY: "fake-test-key", AGENT_MODEL: MODEL };

test("a module's ACP recipe (kit.acpEntry) that names one of the server's keys in `keys` is refused (RECIPE_KEY_NOT_OWN) before its agent starts, naming the key", async (t) => {
  const { harnessTable } = await import("../dist/harness-table.js");
  const dir = await scratch(t);
  for (const key of SERVER_MODEL_KEYS) {
    const id = `key-namer-${key.toLowerCase().replaceAll("_", "-")}`;
    const path = join(dir, `${id}.mjs`);
    writeFileSync(path, `import { gooseFacts, gooseProxy } from ${JSON.stringify(ACP_INDEX)};
import { fakeAgentRecipe } from ${JSON.stringify(ACP_TESTING)};
const facts = Object.freeze({ ...gooseFacts, id: ${JSON.stringify(id)}, label: "Key namer" });
export const entries = (_builtins, kit) => ({ ${JSON.stringify(id)}: kit.acpEntry({
  facts,
  recipe: () => ({ ...fakeAgentRecipe(${JSON.stringify(id)}, ${JSON.stringify(dir)}, [{ say: "NOT_RUN" }]), keys: [${JSON.stringify(key)}], billing: { kind: "proxy" } }),
  proxy: (launch) => gooseProxy({ model: launch.model, provider: launch.provider, price: launch.price, log: launch.log }),
}) });\n`);
    const entry = harnessTable({ AGENTRUN_HARNESS_MODULES: JSON.stringify([path]) })[id];
    const refused = await entry.refusal(KEYED_ENV, undefined, { atStart: false });
    assert.match(refused?.reason ?? "", new RegExp(`^RECIPE_KEY_NOT_OWN: .*${key}`), `a module's recipe naming ${key} is refused by its code and the key`);
  }
});

test("a plan-billed ACP recipe (acpEntryOf's plan branch) that names one of the server's keys in `keys` is refused (RECIPE_KEY_NOT_OWN), and Cursor's own key is not one it is refused for", async (t) => {
  const { acpEntryOf } = await import("../dist/harness-table.js");
  const { cursorFacts } = await import(ACP_INDEX);
  const { fakeAgentRecipe } = await import(ACP_TESTING);
  const dir = await scratch(t);
  for (const key of SERVER_MODEL_KEYS) {
    const id = "plan-key-namer";
    const entry = acpEntryOf({ facts: { ...cursorFacts, id, label: "Plan key namer" }, recipe: () => ({ ...fakeAgentRecipe(id, dir, [{ say: "NOT_RUN" }]), keys: [key] }) }, { log: () => {} });
    const refused = await entry.refusal(KEYED_ENV, undefined, { atStart: false });
    assert.match(refused?.reason ?? "", new RegExp(`^RECIPE_KEY_NOT_OWN: .*${key}`), `a plan recipe naming ${key} is refused by its code and the key`);
  }
  // Cursor's key is the built-in Cursor's own (builtinOwns), by the pair: Cursor's recipe names it, any other id's is refused.
  const cursorKeyed = (id) => acpEntryOf({ facts: { ...cursorFacts, id, label: "Plan key namer" }, recipe: () => ({ ...fakeAgentRecipe(id, dir, [{ say: "NOT_RUN" }]), keys: ["CURSOR_API_KEY"] }) }, { log: () => {} });
  const env = { ...KEYED_ENV, CURSOR_API_KEY: "fake-test-key" };
  assert.match((await cursorKeyed("plan-key-namer").refusal(env, undefined, { atStart: false }))?.reason ?? "", /^RECIPE_KEY_NOT_OWN: .*CURSOR_API_KEY/, "another id's recipe naming Cursor's key");
  assert.doesNotMatch((await cursorKeyed("cursor").refusal(env, undefined, { atStart: false }))?.reason ?? "", /RECIPE_KEY_NOT_OWN/, "Cursor's recipe naming its own key");
});
