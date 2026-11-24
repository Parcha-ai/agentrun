// serve's one debug switch for the ACP adapter, AGENTRUN_LOG=debug, reaches the adapter every ACP entry of the harness
// table builds, whichever way the entry builds it: the built-in Goose's (gooseLaunch, gooseAdapter), the built-in
// Cursor's and a plan-billed recipe's (acpEntryOf's plan branch), a proxy-billed recipe's (its proxy branch). Unset, it
// reaches none. The test walks the table: an entry it does not know (a new ACP entry) fails it until it is walked too.
// What reached each adapter is read from the package itself: a hook hands serve's loader (acp-package.ts) the package
// with each adapter factory recording its options (fixtures/acp-recording.mjs), before serve loads it.
// Goose and Cursor are built from their pinned installs alone, digests checked: AGENTRUN_TEST_GOOSE and
// AGENTRUN_TEST_CURSOR name them (as harness-goose.test.mjs and harness-cursor.test.mjs read them). Where one is not
// named, its entry is refused as not installed, before any adapter is made, and the test says so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import { installGoose } from "./fixtures/goose-installed.mjs";

const PACKAGE = "@parcha/agentrun-harness-acp";
const RECORDING = new URL("./fixtures/acp-recording.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve: (specifier, context, next) => (specifier === PACKAGE ? { url: RECORDING, shortCircuit: true } : next(specifier, context)),
});
after(() => hooks.deregister());

// Only now serve: its loader reads the package once, when it is first asked (adapter-facts.ts asks at import).
const [{ harnessRecipesEnv, harnessTable }, { DATA_ENV }, recipes, { archivePlatform }, { layHarnessKeys }, { HarnessUnavailable }, { RECORDS }, { scratch, withEnv }] = await Promise.all([
  import("../dist/harness-table.js"), import("../dist/files.js"), import("../dist/harness-recipe.js"), import("../dist/harness-archive.js"),
  import("../dist/harness-keys.js"), import("../dist/provider.js"), import(RECORDING), import("./support.mjs"),
]);

const GOOSE = process.env.AGENTRUN_TEST_GOOSE;
const CURSOR = process.env.AGENTRUN_TEST_CURSOR;
/** The table's entries that run on no ACP adapter. */
const NATIVE = ["pi", "claude-agent", "codex", "opencode"];
const MODEL = "claude-sonnet-5-5";
const AGENT = new URL("./fixtures/model-acp-agent.mjs", import.meta.url).pathname;
const PLATFORM = archivePlatform();
const URL_OF = "https://releases.example.invalid/model-agent-1.0.0.tar.bz2";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The stand-in agent's release (harness-recipe.test.mjs's): `./agent`, a script that runs it, in a .tar.bz2. */
async function release(t) {
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  writeFileSync(join(tree, "agent"), `#!/bin/sh\nexec '${process.execPath}' '${AGENT}' "$@"\n`);
  chmodSync(join(tree, "agent"), 0o755);
  const archive = join(dir, "agent.tar.bz2");
  const packed = spawnSync("tar", ["-cjf", archive, "-C", tree, "./agent"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  return { bytes, archiveSha: sha256(bytes) };
}

/** A recipe for the stand-in agent, its release `built`'s, `over` merged over it. */
const recipeOf = (built, over = {}) => ({
  id: "model-agent",
  label: "Model Agent",
  release: { registry: "model-agent", version: "1.0.0", archives: { [PLATFORM]: { url: URL_OF, format: "tar.bz2", sha256: built.archiveSha, cmd: "./agent" } } },
  env: { MODEL_AGENT_MODE: "good" },
  model: { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL" },
  files: { ".config/model-agent/settings.json": "{\"telemetry\": false}\n" },
  state: [".model-agent/sessions"],
  declares: { load: true, mcp: "http" },
  allowFile: { path: ".config/goose/permission.yaml", form: "goose-permission" },
  ...over,
});

/** `recipe` written to a file, installed from `built` into `data` and noted as checked, as a passed harness-check notes
 *  it: the file. */
async function installed(t, data, built, recipe) {
  const file = join(await scratch(t), `${recipe.id}.json`);
  writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`);
  const fetch = async (url) => (String(url) === URL_OF ? new Response(built.bytes, { status: 200 }) : new Response("no", { status: 404 }));
  await recipes.installRecipe(recipes.loadRecipe(file).recipe, file, data, { fetch });
  const { recipe: loaded, sha256: recipeSha } = recipes.loadRecipe(file);
  const at = recipes.releaseFor(loaded, PLATFORM);
  recipes.writeChecked(data, loaded.id, { recipe: recipeSha, binary: recipes.pinnedDigest(data, loaded, at, PLATFORM).sha256, tree: recipes.pinnedTree(data, loaded, at, PLATFORM).sha256, version: loaded.release.version, platform: PLATFORM });
  return file;
}

/** For each ACP entry of `env`'s table, built under AGENTRUN_LOG as `value` says (undefined: unset): each adapter
 *  factory it called and whether `debug: true` reached it, or "not installed here" where it was refused for that. */
async function walk(env, value) {
  if (value === undefined) delete process.env.AGENTRUN_LOG;
  else process.env.AGENTRUN_LOG = value;
  const calls = (globalThis[RECORDS] ??= []);
  const table = harnessTable(env);
  const seen = {};
  for (const id of Object.keys(table).filter((one) => !NATIVE.includes(one)).sort()) {
    calls.length = 0;
    const model = table[id].facts?.wire === "anthropic-messages" ? { provider: "anthropic", modelId: MODEL } : { provider: id, modelId: "default" };
    try {
      await table[id].adapter(env, { model, models: { getModel: () => undefined } });
      seen[id] = calls.map((call) => [call.factory, call.debug === true]);
    } catch (error) {
      assert.ok(error instanceof HarnessUnavailable && /NOT_INSTALLED|not installed/i.test(error.message), `${id}: ${error?.stack ?? error}`);
      assert.deepEqual(calls, [], `${id} made no adapter before its refusal`);
      seen[id] = "not installed here";
    }
  }
  return seen;
}

test("AGENTRUN_LOG=debug reaches the adapter every ACP entry of the harness table builds: the built-in Goose's, the built-in Cursor's, a proxy-billed recipe's and a plan-billed recipe's; unset, it reaches none", { timeout: 120_000 }, async (t) => {
  // Both restored after the test.
  withEnv(t, {}, ["AGENTRUN_LOG", "AGENT_MODEL_BASE_URL"]);
  const data = join(await scratch(t), "agents");
  mkdirSync(join(data, "harnesses"), { recursive: true });
  if (GOOSE) installGoose(data);
  if (CURSOR) symlinkSync(CURSOR, join(data, "harnesses", "cursor"));
  const built = await release(t);
  const proxy = await installed(t, data, built, recipeOf(built));
  const plan = await installed(t, data, built, recipeOf(built, {
    id: "plan-agent",
    label: "Plan Agent",
    keys: ["MODEL_AGENT_API_KEY"],
    env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: "127.0.0.1:9", MODEL_AGENT_MODEL: "vendor-model" },
    model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["127.0.0.1:9"] },
  }));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, [DATA_ENV]: data, ...harnessRecipesEnv([proxy, plan], data), ANTHROPIC_API_KEY: "fake-test-key", ...(CURSOR ? { CURSOR_API_KEY: "fake-test-key" } : {}) };
  // The plan-billed recipe's key, as a start's claim lays it.
  layHarnessKeys(env, { MODEL_AGENT_API_KEY: "fake-harness-key" });

  const expect = (debug) => ({
    cursor: CURSOR ? [["acpAdapter", debug]] : "not installed here",
    goose: GOOSE ? [["gooseAdapter", debug]] : "not installed here",
    "model-agent": [["acpAdapter", debug]],
    "plan-agent": [["acpAdapter", debug]],
  });
  assert.deepEqual(await walk(env, "debug"), expect(true));
  assert.deepEqual(await walk(env, undefined), expect(false));
  assert.deepEqual(await walk(env, "quiet"), expect(false));
  if (!GOOSE) t.diagnostic("AGENTRUN_TEST_GOOSE is not set: Goose's entry was refused as not installed, so its adapter was not walked");
  if (!CURSOR) t.diagnostic("AGENTRUN_TEST_CURSOR is not set: Cursor's entry was refused as not installed, so its adapter was not walked");
});
