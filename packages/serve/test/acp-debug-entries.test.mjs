// serve's one debug switch for the ACP adapter, AGENTRUN_LOG=debug, reaches the adapter every ACP entry of the harness
// table builds, whichever way the entry builds it: the built-in Goose's (gooseLaunch, gooseAdapter), the built-in
// Cursor's and a plan-billed recipe's (acpEntryOf's plan branch), a proxy-billed recipe's (its proxy branch). Unset, it
// reaches none. The test walks the table: an entry it does not know (a new ACP entry) fails it until it is walked too.
// What reached each adapter is read from the package itself: a hook hands serve's loader (acp-package.ts) the package
// with each adapter factory recording its options (fixtures/acp-recording.mjs), before serve loads it.
// No real release is needed, so it runs anywhere: Goose and Cursor are built on stand-ins installed where their installs
// go, pinned in that package by their own digests (its GOOSE_PIN and CURSOR_PIN). Serve's checks run unchanged on them:
// Goose's binary sha256 and Cursor's tree digest against the pin, before gooseLaunch and Cursor's entry reach a factory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";

const PACKAGE = "@parcha/agentrun-harness-acp";
const RECORDING = new URL("./fixtures/acp-recording.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve: (specifier, context, next) => (specifier === PACKAGE ? { url: RECORDING, shortCircuit: true } : next(specifier, context)),
});
after(() => hooks.deregister());

// Only now serve: its loader reads the package once, when it is first asked (adapter-facts.ts asks at import).
const [{ harnessRecipesEnv, harnessTable }, { DATA_ENV }, recipes, { archivePlatform }, { layHarnessKeys }, { HarnessUnavailable }, recording, { scratch, withEnv }] = await Promise.all([
  import("../dist/harness-table.js"), import("../dist/files.js"), import("../dist/harness-recipe.js"), import("../dist/harness-archive.js"),
  import("../dist/harness-keys.js"), import("../dist/provider.js"), import(RECORDING), import("./support.mjs"),
]);

const { RECORDS } = recording;
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

/** A stand-in for an owner-installed release in `data` (Goose's, Cursor's): an executable at `cmd` in its folder, pinned
 *  in the recording package's `pin` by its sha256 and, for a tree, by the folder's digest, as the real pin holds them. */
async function standIn(data, id, pin, cmd, tree = false) {
  const root = join(data, "harnesses", id);
  const binary = join(root, cmd);
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  const archive = { url: `https://releases.example.invalid/${id}.tar.gz`, format: "tar.gz", sha256: "0".repeat(64), cmd: `./${cmd}`, binarySha256: sha256(readFileSync(binary)) };
  pin.archives[recording.acpPlatform()] = tree ? { ...archive, treeSha256: await recording.treeDigest(root) } : archive;
}

/** For each ACP entry of `env`'s table, built under AGENTRUN_LOG as `value` says (undefined: unset): each adapter
 *  factory it called and whether `debug: true` reached it. */
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
    } catch (error) {
      assert.fail(`${id}'s adapter was not built: ${error instanceof HarnessUnavailable ? error.message : error?.stack ?? error}`);
    }
    seen[id] = calls.map((call) => [call.factory, call.debug === true]);
  }
  return seen;
}

test("AGENTRUN_LOG=debug reaches the adapter every ACP entry of the harness table builds: the built-in Goose's, the built-in Cursor's, a proxy-billed recipe's and a plan-billed recipe's; unset, it reaches none", { timeout: 120_000 }, async (t) => {
  // Both restored after the test.
  withEnv(t, {}, ["AGENTRUN_LOG", "AGENT_MODEL_BASE_URL"]);
  const data = join(await scratch(t), "agents");
  mkdirSync(join(data, "harnesses"), { recursive: true });
  await standIn(data, "goose", recording.GOOSE_PIN, "goose");
  await standIn(data, "cursor", recording.CURSOR_PIN, "dist-package/cursor-agent", true);
  const built = await release(t);
  const proxy = await installed(t, data, built, recipeOf(built));
  const plan = await installed(t, data, built, recipeOf(built, {
    id: "plan-agent",
    label: "Plan Agent",
    keys: ["MODEL_AGENT_API_KEY"],
    env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: "127.0.0.1:9", MODEL_AGENT_MODEL: "vendor-model" },
    model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["127.0.0.1:9"] },
  }));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, [DATA_ENV]: data, ...harnessRecipesEnv([proxy, plan], data), ANTHROPIC_API_KEY: "fake-test-key", CURSOR_API_KEY: "fake-test-key" };
  // The plan-billed recipe's key, as a start's claim lays it.
  layHarnessKeys(env, { MODEL_AGENT_API_KEY: "fake-harness-key" });

  const expect = (debug) => ({
    cursor: [["acpAdapter", debug]],
    goose: [["gooseAdapter", debug]],
    "model-agent": [["acpAdapter", debug]],
    "plan-agent": [["acpAdapter", debug]],
  });
  assert.deepEqual(await walk(env, "debug"), expect(true));
  assert.deepEqual(await walk(env, undefined), expect(false));
  assert.deepEqual(await walk(env, "quiet"), expect(false));
});
