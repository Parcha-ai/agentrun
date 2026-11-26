// The harness recipes this package ships whole (recipes/bundled): each one a recipe file as AgentRun's server loads it
// (HARNESS.md#a-recipe, serve's harness-recipe.ts), its five rules, its pins and its check its own, named by its id.
// Google Antigravity's is the one (agy CLI 1.5.14, checked with harness-check). Not a harness module: no code here is
// any one agent's. Written for AgentRun.
import { fileURLToPath } from "node:url";

/** The recipes this package ships, by name: each one its recipe's id, and none a built-in harness's. */
export const BUNDLED_RECIPES: readonly string[] = Object.freeze(["antigravity"]);

/** The file of the recipe this package ships as `name`, absolute; undefined for any other name. */
export function bundledRecipePath(name: string): string | undefined {
  return BUNDLED_RECIPES.includes(name) ? fileURLToPath(new URL(`../recipes/bundled/${name}.json`, import.meta.url)) : undefined;
}
