// The test files `npm run test:pg` runs (scripts/test-pg.mjs), and their shares when the suite runs in several jobs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HELPERS = /from "\.\/(?:store-helpers|store-support|runner-support|store-target)\.mjs"/;

/** Every test file under `root`'s test/ that opens the store through the tests' helpers, as `test/<name>`, sorted by name. */
export function pgTestFiles(root) {
  return readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => HELPERS.test(readFileSync(join(root, "test", name), "utf8")))
    .sort()
    .map((name) => join("test", name));
}

/** `--shard=<k>/<n>` as `{ k, n }`, the k-th of n shares; throws on any other text. */
export function parseShard(text) {
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`${text} is not --shard=<k>/<n>, the k-th of n shares (1/4 to 4/4, say)`);
  return { k: Number(match[1]), n: Number(match[2]) };
}

/**
 * The k-th of n shares of `files`: every n-th file from the k-th, in the order given. The n shares hold every file once,
 * and files that sort together (one feature's, which tend to take alike) are spread over them.
 */
export function shareOf(files, { k, n }) {
  return files.filter((_, index) => index % n === k - 1);
}
