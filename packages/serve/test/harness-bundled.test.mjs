// The harness recipes AgentRun ships (@parcha/agentrun-harness-acp's recipes/bundled: Google Antigravity's), named by their
// id wherever a recipe file is taken (agentrun harness install NAME, --recipe NAME, --harness-recipe NAME). A recipe still:
// the five rules, its pins, its keys page, its sign-in and its check are a recipe file's. A name never shadows a file of
// the same name in the directory it is given in, and never a built-in harness's id; each command says which resolved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const [recipes, table, acp] = await Promise.all([import("../dist/harness-recipe.js"), import("../dist/harness-table.js"), import("@parcha/agentrun-harness-acp")]);
const { loadRecipe, recipeCheckLine, recipeInstallLine, recipeSignInLine, RECIPE_CODES, RecipeRefused, resolveRecipe } = recipes;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SHIPPED = new URL("../../run-adapters-acp/recipes/bundled/antigravity.json", import.meta.url).pathname;

function scratchDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-bundled-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the ACP package ships Google Antigravity's recipe by name: each bundled name is its recipe's own id, loads under the five rules, and is no built-in harness's id", () => {
  assert.deepEqual([...acp.BUNDLED_RECIPES], ["antigravity"]);
  for (const name of acp.BUNDLED_RECIPES) {
    const file = acp.bundledRecipePath(name);
    assert.equal(file, SHIPPED);
    const { recipe, bundled } = loadRecipe(name);
    assert.equal(recipe.id, name, "a bundled name is its recipe's id");
    assert.equal(bundled, true);
    assert.equal(table.BUILTIN_HARNESS_IDS.includes(name), false, `${name} is a built-in harness's id`);
  }
  assert.equal(acp.bundledRecipePath("goose"), undefined, "a built-in harness is no bundled recipe");
  assert.equal(acp.bundledRecipePath("../antigravity"), undefined);
});

test("a bundled name resolves to the shipped file, a path to the file it names, and a name a file in that directory also holds is refused, saying both", (t) => {
  const dir = scratchDir(t);
  assert.deepEqual(resolveRecipe("antigravity", dir), { file: SHIPPED, bundled: true });
  writeFileSync(join(dir, "mine.json"), "{}");
  assert.deepEqual(resolveRecipe("mine.json", dir), { file: join(dir, "mine.json"), bundled: false });
  // The owner's own file named as the bundled recipe is: never read in its place, never silently passed over.
  writeFileSync(join(dir, "antigravity"), "{}");
  let refused;
  assert.throws(() => resolveRecipe("antigravity", dir), (error) => (refused = error) instanceof RecipeRefused);
  assert.equal(refused.code, RECIPE_CODES.invalid);
  assert.match(refused.message, /antigravity names both the recipe AgentRun ships .* and the file .*antigravity in this directory: write \.\/antigravity for your file, or name the shipped one from another directory/);
  assert.deepEqual(resolveRecipe("./antigravity", dir), { file: join(dir, "antigravity"), bundled: false });
  assert.deepEqual(resolveRecipe(join(dir, "antigravity"), dir), { file: join(dir, "antigravity"), bundled: false });
});

test("the commands a bundled recipe's refusals and notes print name it by its name, not by where its package is installed", (t) => {
  const data = scratchDir(t);
  assert.equal(recipeInstallLine(SHIPPED, data), `agentrun harness install antigravity --data ${data}`);
  assert.equal(recipeCheckLine(SHIPPED, data), `agentrun harness-check --recipe antigravity --data ${data}`);
  assert.equal(recipeSignInLine(SHIPPED, data), `agentrun harness sign-in --recipe antigravity --data ${data}`);
  const mine = join(data, "mine.json");
  assert.equal(recipeCheckLine(mine, data), `agentrun harness-check --recipe ${mine} --data ${data}`);
});

test("--harness-recipe antigravity adds the shipped recipe's harness to a server's table, by its file", (t) => {
  const data = scratchDir(t);
  const env = table.harnessRecipesEnv(["antigravity"], data);
  assert.deepEqual(JSON.parse(env[table.HARNESS_RECIPES_ENV]).files, [SHIPPED]);
  assert.ok(table.harnessIds(env).includes("antigravity"));
});

test("agentrun-serve install-harness antigravity installs the shipped recipe's release, and says which recipe it is; with --recipe too it is refused", (t) => {
  const dir = scratchDir(t);
  const data = join(dir, "data");
  mkdirSync(data);
  // A dead proxy: the download is tried and fails, so nothing leaves this machine.
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR ?? tmpdir(), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", AGENTRUN_TELEMETRY: "0" };
  const run = (args) => spawnSync(process.execPath, [CLI, "install-harness", ...args, "--data", data], { cwd: dir, encoding: "utf8", env, timeout: 60_000 });
  const named = run(["antigravity"]);
  assert.match(named.stderr, /^Google Antigravity: the recipe AgentRun ships \(.*recipes\/bundled\/antigravity\.json\)$/m);
  assert.equal(named.status, 1, named.stderr);
  const both = run(["antigravity", "--recipe", "antigravity"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /a harness's name or --recipe FILE, not both/);
  // --recipe NAME says it too, and a file of that name in the directory refuses it.
  assert.match(run(["--recipe", "antigravity"]).stderr, /^Google Antigravity: the recipe AgentRun ships /m);
  writeFileSync(join(dir, "antigravity"), readFileSync(SHIPPED));
  const shadowed = run(["--recipe", "antigravity"]);
  assert.equal(shadowed.status, 1);
  assert.match(shadowed.stderr, /^RECIPE_INVALID: antigravity names both the recipe AgentRun ships/m);
  assert.match(run(["--recipe", "./antigravity"]).stderr, /^Google Antigravity: the recipe file .*\/antigravity$/m);
});
